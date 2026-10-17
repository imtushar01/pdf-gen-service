/**
 * jobs.service.ts
 *
 * Orchestrates single-document job creation and retrieval.
 *
 * This is the heart of Milestone 4. It handles:
 * 1. Document validation (delegated to DocumentValidationService)
 * 2. Idempotency (the three cases — see createJob below)
 * 3. Immutable snapshot persistence (in the same transaction as the job)
 *
 * SOLID — Single Responsibility: this service orchestrates. It delegates
 * validation to DocumentValidationService and persistence to PrismaService.
 * It does NOT render PDFs (that's the worker's job in M7) or handle HTTP
 * (that's the controller's job).
 *
 * SOLID — Dependency Inversion: depends on injected PrismaService and
 * DocumentValidationService abstractions, not concrete implementations.
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Job } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentValidationService } from '../documents/document-validation.service';
import { CreateJobDto, DocumentType } from '../documents/dto/create-job.dto';
import { fingerprintPayload } from '../common/utils/fingerprint.util';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: DocumentValidationService,
  ) {}

  /**
   * Create a single-document generation job.
   *
   * IDEMPOTENCY — three cases:
   *
   * Case 1: Same key, same payload → return the existing job (legitimate retry)
   * Case 2: Same key, different payload → throw 409 Conflict
   * Case 3: New key → create a new job
   *
   * CONCURRENCY: Two identical requests arriving simultaneously both pass
   * the "does the key exist?" check, then both try to INSERT. The database
   * UNIQUE constraint on idempotencyKey rejects the second insert with a
   * P2002 error. We catch it and treat it as Case 1.
   *
   * ATOMICITY: The Job and its InputSnapshot are created in a single
   * transaction. A crash mid-way can't leave a job without its snapshot.
   */
  async createJob(dto: CreateJobDto): Promise<{ job: Job; isExisting: boolean }> {
    // Step 1: Validate the document data against its type.
    // This throws BadRequestException if invalid.
    await this.validationService.validateDocument(dto.documentType, dto.data);

    // Step 2: Compute the payload fingerprint for idempotency comparison.
    const payloadHash = fingerprintPayload(dto.data);

    // Step 3: Determine the idempotency key.
    // If the caller didn't supply one, we generate a random UUID so every
    // request without a key is treated as unique (no accidental dedup).
    const idempotencyKey = dto.idempotencyKey ?? `auto-${randomUUID()}`;

    // Step 4: Check for an existing job with this key.
    const existing = await this.prisma.job.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      return this.handleExistingJob(existing, payloadHash, idempotencyKey);
    }

    // Step 5: No existing job — create a new one with its snapshot atomically.
    return this.createNewJob(dto, idempotencyKey, payloadHash);
  }

  /**
   * Handle Case 1 / Case 2: a job with this idempotency key already exists.
   */
  private handleExistingJob(
    existing: Job,
    payloadHash: string,
    idempotencyKey: string,
  ): { job: Job; isExisting: boolean } {
    if (existing.payloadHash === payloadHash) {
      // Case 1: same key, same payload → legitimate retry
      this.logger.log(
        `Idempotent retry for key ${idempotencyKey} → returning existing job ${existing.id}`,
      );
      return { job: existing, isExisting: true };
    }

    // Case 2: same key, DIFFERENT payload → conflict
    this.logger.warn(
      `Idempotency key ${idempotencyKey} reused with a different payload`,
    );
    throw new ConflictException({
      message:
        'Idempotency key was already used with a different payload. ' +
        'Use a new idempotency key for different data.',
      existingJobId: existing.id,
    });
  }

  /**
   * Create a new job and its immutable snapshot in a single transaction.
   */
  private async createNewJob(
    dto: CreateJobDto,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ job: Job; isExisting: boolean }> {
    try {
      const job = await this.prisma.$transaction(async (tx) => {
        return tx.job.create({
          data: {
            documentType: dto.documentType as DocumentType,
            idempotencyKey,
            payloadHash,
            // The snapshot is created in the SAME transaction.
            // This is the immutable copy of the input at acceptance time.
            snapshot: {
              create: {
                data: dto.data as Prisma.InputJsonValue,
              },
            },
          },
        });
      });

      this.logger.log(
        `Created job ${job.id} (${job.documentType}) with key ${idempotencyKey}`,
      );
      return { job, isExisting: false };
    } catch (err) {
      // CONCURRENCY: If a parallel request inserted the same key between
      // our findUnique check and this insert, the UNIQUE constraint throws
      // P2002. We treat that as Case 1 — fetch and return the existing job.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Concurrent insert detected for key ${idempotencyKey} — fetching existing job`,
        );
        const raced = await this.prisma.job.findUnique({
          where: { idempotencyKey },
        });
        if (raced) {
          // Verify the payload matches (otherwise it's a genuine conflict)
          if (raced.payloadHash === payloadHash) {
            return { job: raced, isExisting: true };
          }
          throw new ConflictException({
            message:
              'Idempotency key was already used with a different payload.',
            existingJobId: raced.id,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Fetch a job by ID. Throws 404 if not found.
   */
  async getJob(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  /**
   * Fetch the immutable snapshot for a job.
   * Used by the worker (M7) to render from frozen data.
   */
  async getSnapshot(jobId: string): Promise<Prisma.JsonValue> {
    const snapshot = await this.prisma.inputSnapshot.findUnique({
      where: { jobId },
    });
    if (!snapshot) {
      throw new NotFoundException(`Snapshot for job ${jobId} not found`);
    }
    return snapshot.data;
  }
}
