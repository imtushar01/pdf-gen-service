/**
 * artifact.service.ts
 *
 * Bridges storage and the database for PDF artifacts.
 *
 * Responsibilities:
 *   1. Persist a generated PDF buffer via the storage service (atomic write).
 *   2. Record the artifact's metadata (storage key, size, SHA-256) in the DB.
 *   3. Provide checksum verification (re-hash the stored file, compare to DB).
 *
 * SOLID — Single Responsibility: this service coordinates storage + metadata.
 * It does NOT render PDFs or handle HTTP.
 *
 * SOLID — Dependency Inversion: depends on IStorageService (via the
 * STORAGE_SERVICE token), not on the filesystem directly. The S3 swap
 * is invisible to this class.
 *
 * ── Tamper evidence (what SHA-256 proves and doesn't) ──────────────────────
 * We store the SHA-256 of each PDF at creation time. To check tampering,
 * re-hash the stored file and compare to the DB value.
 *   Proves: the file bytes are unchanged since we stored them, AS LONG AS
 *           the reference hash in the DB is itself protected.
 *   Does NOT prove: authenticity, non-repudiation, or a digital signature.
 *           Anyone who can modify both the file AND the DB hash defeats it.
 * This is documented honestly in APPROACH.md.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Artifact } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../storage/storage.interface';

export interface VerificationResult {
  valid: boolean;
  storedChecksum: string;
  computedChecksum: string;
}

@Injectable()
export class ArtifactService {
  private readonly logger = new Logger(ArtifactService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE)
    private readonly storage: IStorageService,
  ) {}

  /**
   * Save a generated PDF for a job: write bytes atomically, record metadata.
   * The storage key is derived from a UUID so filenames never leak
   * customer data (invoice numbers, names) onto disk.
   */
  async saveJobArtifact(jobId: string, pdf: Buffer): Promise<Artifact> {
    const key = `pdfs/${randomUUID()}.pdf`;

    // Atomic write + checksum in one call
    const { sha256, sizeBytes } = await this.storage.save(key, pdf);

    // Record metadata. The Artifact has a unique constraint on jobId,
    // so a duplicate save for the same job would fail — which is correct,
    // a job produces exactly one artifact.
    const artifact = await this.prisma.artifact.create({
      data: {
        jobId,
        storagePath: key,
        sha256,
        sizeBytes,
        mimeType: 'application/pdf',
      },
    });

    this.logger.log(`Recorded artifact ${artifact.id} for job ${jobId}`);
    return artifact;
  }

  /** Fetch artifact metadata for a job. Returns null if not yet generated. */
  async getByJobId(jobId: string): Promise<Artifact | null> {
    return this.prisma.artifact.findUnique({ where: { jobId } });
  }

  /**
   * Verify a stored artifact's integrity by re-hashing the file and
   * comparing to the checksum recorded in the database.
   */
  async verifyChecksum(jobId: string): Promise<VerificationResult> {
    const artifact = await this.prisma.artifact.findUnique({
      where: { jobId },
    });
    if (!artifact) {
      throw new Error(`No artifact recorded for job ${jobId}`);
    }

    const computed = await this.storage.computeChecksum(artifact.storagePath);
    return {
      valid: computed === artifact.sha256,
      storedChecksum: artifact.sha256,
      computedChecksum: computed,
    };
  }
}
