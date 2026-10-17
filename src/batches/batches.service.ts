/**
 * batches.service.ts
 *
 * Orchestrates bulk (batch) PDF generation.
 *
 * CREATE FLOW (createBatch):
 *   1. Validate every document up front (fail the whole batch on bad input
 *      rather than accepting a batch we know contains invalid items).
 *   2. In one transaction, create the Batch + N Jobs + N snapshots + N
 *      BatchItems. Atomic: either the whole batch is accepted or none of it.
 *   3. Enqueue each child job for rendering (reusing the M7 worker pipeline).
 *
 * COMPLETION FLOW (onChildJobDone):
 *   Called by the worker when a child job finishes (success or terminal fail).
 *   1. Atomically increment completedCount / failedCount.
 *   2. Check if this was the last job (completed + failed == total).
 *   3. RACE-SAFE FINALIZATION: use a conditional update to claim the batch
 *      for finalization. Only one worker can win. The winner builds the ZIP.
 *
 * SOLID — Single Responsibility: this service owns batch lifecycle and
 * finalization. It delegates ZIP building to ZipBuilderService and job
 * creation/queueing to the same primitives JobsService uses.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, Batch, BatchStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentValidationService } from '../documents/document-validation.service';
import { CreateBatchDto } from '../documents/dto/batch-item-request.dto';
import { DocumentType } from '../documents/dto/create-job.dto';
import { fingerprintPayload } from '../common/utils/fingerprint.util';
import { PDF_QUEUE, RENDER_JOB, RenderJobData } from '../queue/queue.constants';
import {
  ZipBuilderService,
  ZipEntry,
  FailureManifestEntry,
} from './zip-builder.service';
import { ArtifactService } from '../artifacts/artifact.service';

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: DocumentValidationService,
    private readonly zipBuilder: ZipBuilderService,
    private readonly artifactService: ArtifactService,
    @InjectQueue(PDF_QUEUE)
    private readonly pdfQueue: Queue<RenderJobData>,
  ) {}

  /**
   * Create a bulk batch of up to 100 documents.
   */
  async createBatch(dto: CreateBatchDto): Promise<Batch> {
    // Step 1: Validate ALL documents up front.
    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      try {
        await this.validation.validateDocument(item.documentType, item.data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Batch item ${i} (sequence ${i}) failed validation: ${msg}`,
        );
      }
    }

    const batchKey = dto.idempotencyKey ?? `batch-${randomUUID()}`;

    // Step 2: Create batch + child jobs + snapshots + items atomically.
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({
        data: { totalCount: dto.items.length },
      });

      for (let i = 0; i < dto.items.length; i++) {
        const item = dto.items[i];
        const payloadHash = fingerprintPayload(item.data);
        // Child idempotency key derived from batch key + sequence — unique.
        const childKey = `${batchKey}-${i}`;

        await tx.job.create({
          data: {
            documentType: item.documentType as DocumentType,
            idempotencyKey: childKey,
            payloadHash,
            snapshot: { create: { data: item.data as Prisma.InputJsonValue } },
            batchItem: {
              create: { batchId: created.id, sequenceNumber: i },
            },
          },
        });
      }

      return created;
    });

    // Step 3: Enqueue all child jobs for rendering.
    const items = await this.prisma.batchItem.findMany({
      where: { batchId: batch.id },
      orderBy: { sequenceNumber: 'asc' },
    });

    for (const item of items) {
      await this.pdfQueue.add(
        RENDER_JOB,
        { jobId: item.jobId },
        { jobId: item.jobId },
      );
    }

    this.logger.log(
      `Created batch ${batch.id} with ${dto.items.length} child jobs`,
    );
    return batch;
  }

  /**
   * Fetch a batch with its items and ZIP artifact.
   */
  async getBatch(id: string): Promise<Batch & { items: unknown[] }> {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: {
        items: {
          include: { job: true },
          orderBy: { sequenceNumber: 'asc' },
        },
        zipArtifact: true,
      },
    });
    if (!batch) {
      throw new NotFoundException(`Batch ${id} not found`);
    }
    return batch as Batch & { items: unknown[] };
  }

  /**
   * Called by the worker when a child job reaches a terminal state.
   * Atomically updates counters and triggers finalization when complete.
   *
   * @param jobId   the child job that just finished
   * @param success whether it completed (true) or failed terminally (false)
   */
  async onChildJobDone(jobId: string, success: boolean): Promise<void> {
    const item = await this.prisma.batchItem.findUnique({ where: { jobId } });
    if (!item) {
      // Not a batch job — nothing to do.
      return;
    }
    const batchId = item.batchId;

    // Atomically increment the appropriate counter and flip PENDING→PROCESSING.
    const updated = await this.prisma.batch.update({
      where: { id: batchId },
      data: {
        status: BatchStatus.PROCESSING,
        ...(success
          ? { completedCount: { increment: 1 } }
          : { failedCount: { increment: 1 } }),
      },
    });

    // Are all children done now?
    if (updated.completedCount + updated.failedCount >= updated.totalCount) {
      await this.tryFinalize(batchId);
    }
  }

  /**
   * RACE-SAFE FINALIZATION.
   *
   * Many workers may call this simultaneously when the last few jobs finish
   * at once. We use an atomic conditional update to claim the batch: only the
   * single update whose WHERE clause still sees a non-finalized status will
   * affect a row. That winner builds the ZIP; all other callers see count 0
   * and return.
   */
  private async tryFinalize(batchId: string): Promise<void> {
    // Claim: move PROCESSING → FINALIZING only if still PROCESSING.
    // updateMany returns the number of rows affected — exactly 1 for the
    // winner, 0 for everyone else.
    const claim = await this.prisma.batch.updateMany({
      where: { id: batchId, status: BatchStatus.PROCESSING },
      data: { status: BatchStatus.FINALIZING },
    });

    if (claim.count === 0) {
      // Someone else is already finalizing (or it's already done).
      return;
    }

    this.logger.log(`Claimed batch ${batchId} for finalization`);

    try {
      await this.finalizeBatch(batchId);
    } catch (err) {
      // If ZIP building fails, revert to PROCESSING so a recovery job (M9)
      // can retry finalization rather than leaving it stuck in FINALIZING.
      this.logger.error(
        `Finalization failed for batch ${batchId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.prisma.batch
        .update({
          where: { id: batchId },
          data: { status: BatchStatus.PROCESSING },
        })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Build the ZIP of all successful PDFs, record the ZipArtifact, and set the
   * final batch status (COMPLETED / PARTIAL_FAILURE / FAILED).
   */
  private async finalizeBatch(batchId: string): Promise<void> {
    const items = await this.prisma.batchItem.findMany({
      where: { batchId },
      include: { job: { include: { artifact: true } } },
      orderBy: { sequenceNumber: 'asc' },
    });

    const zipEntries: ZipEntry[] = [];
    const failures: FailureManifestEntry[] = [];

    for (const item of items) {
      const job = item.job;
      if (job.status === 'COMPLETED' && job.artifact) {
        zipEntries.push({
          filename: `${item.sequenceNumber + 1}-${job.documentType.toLowerCase()}-${job.id.slice(0, 8)}.pdf`,
          storageKey: job.artifact.storagePath,
        });
      } else {
        failures.push({
          sequenceNumber: item.sequenceNumber,
          documentType: job.documentType,
          error: job.errorMessage ?? `Job ended in status ${job.status}`,
        });
      }
    }

    // Build and persist the ZIP (even if some failed — successes are kept).
    // If EVERY item failed, we still create an (almost empty) ZIP containing
    // just the failure manifest so the client has a consistent artifact.
    const zip = await this.zipBuilder.buildBatchZip(
      batchId,
      zipEntries,
      failures,
    );

    // Record the ZipArtifact + final status atomically.
    const finalStatus =
      failures.length === 0
        ? BatchStatus.COMPLETED
        : zipEntries.length === 0
          ? BatchStatus.FAILED
          : BatchStatus.PARTIAL_FAILURE;

    await this.prisma.$transaction(async (tx) => {
      await tx.zipArtifact.create({
        data: {
          batchId,
          storagePath: zip.key,
          sha256: zip.sha256,
          sizeBytes: zip.sizeBytes,
          failureManifest:
            failures.length > 0
              ? (failures as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });
      await tx.batch.update({
        where: { id: batchId },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          errorSummary:
            failures.length > 0
              ? `${failures.length} of ${items.length} documents failed`
              : null,
        },
      });
    });

    this.logger.log(
      `Finalized batch ${batchId}: ${finalStatus} ` +
        `(${zipEntries.length} ok, ${failures.length} failed)`,
    );
  }
}
