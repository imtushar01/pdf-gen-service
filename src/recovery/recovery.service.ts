/**
 * recovery.service.ts
 *
 * Periodic reconciler that heals jobs/batches stuck in bad states due to
 * crashes or the database-to-queue window.
 *
 * It runs on the WORKER process (not the API) on a fixed interval, and can
 * also be invoked once manually (reconcileNow) — e.g. on worker startup.
 *
 * ── Three recovery actions ─────────────────────────────────────────────────
 *
 * 1. ORPHANED PENDING JOBS (database-to-queue gap):
 *    Jobs in PENDING older than a grace period that are NOT in the queue get
 *    re-enqueued. Safe because the BullMQ job ID == DB job ID, so re-adding
 *    an already-queued job is a no-op (BullMQ dedupes by ID).
 *
 * 2. STALE PROCESSING JOBS (worker crash mid-render):
 *    Jobs stuck in PROCESSING past a timeout, with no active queue job, are
 *    reset to PENDING and re-enqueued. The idempotent processor + artifact
 *    unique constraint make re-running safe even if the previous attempt
 *    had already written the artifact.
 *
 * 3. STUCK FINALIZING BATCHES (worker crash during ZIP build):
 *    Batches stuck in FINALIZING past a timeout are reverted to PROCESSING
 *    and finalization is retried. The ZIP build is itself idempotent (atomic
 *    write to a deterministic key overwrites any partial), and ZipArtifact
 *    creation is guarded, so retrying is safe.
 *
 * ── Why a reconciler and not a transactional outbox? ───────────────────────
 * The outbox gives stronger guarantees but needs an outbox table + relay +
 * dedup. Our design already makes re-enqueue safe (jobId == DB id), so a
 * simpler periodic reconciler is sufficient at this scale. The outbox is
 * documented as a future improvement in APPROACH.md.
 *
 * SOLID — Single Responsibility: this service only detects and heals stuck
 * states. Rendering, storage, and finalization live in their own services.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PDF_QUEUE, RENDER_JOB, RenderJobData } from '../queue/queue.constants';
import { BatchesService } from '../batches/batches.service';

/** How long a job may sit in PENDING before we consider it orphaned. */
const PENDING_GRACE_MS = 30_000;
/** How long a job may sit in PROCESSING before we consider the worker dead. */
const PROCESSING_TIMEOUT_MS = 120_000;
/** How long a batch may sit in FINALIZING before we retry finalization. */
const FINALIZING_TIMEOUT_MS = 120_000;

export interface ReconcileReport {
  requeuedPending: number;
  resetProcessing: number;
  retriedFinalizing: number;
}

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PDF_QUEUE)
    private readonly pdfQueue: Queue<RenderJobData>,
    private readonly batchesService: BatchesService,
  ) {}

  /**
   * Scheduled sweep. Runs every minute on the worker process.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledReconcile(): Promise<void> {
    try {
      const report = await this.reconcileNow();
      if (
        report.requeuedPending +
          report.resetProcessing +
          report.retriedFinalizing >
        0
      ) {
        this.logger.log(
          `Reconcile: requeued ${report.requeuedPending} pending, ` +
            `reset ${report.resetProcessing} processing, ` +
            `retried ${report.retriedFinalizing} finalizing`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Run one reconciliation pass. Returns a report of what was healed.
   * Idempotent — safe to run repeatedly.
   */
  async reconcileNow(): Promise<ReconcileReport> {
    const requeuedPending = await this.requeueOrphanedPending();
    const resetProcessing = await this.resetStaleProcessing();
    const retriedFinalizing = await this.retryStuckFinalizing();
    return { requeuedPending, resetProcessing, retriedFinalizing };
  }

  /** Action 1: re-enqueue PENDING jobs that never made it onto the queue. */
  private async requeueOrphanedPending(): Promise<number> {
    const cutoff = new Date(Date.now() - PENDING_GRACE_MS);
    const orphans = await this.prisma.job.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500, // bound the batch size per sweep
    });

    let count = 0;
    for (const job of orphans) {
      // Only enqueue if not already queued. getJob returns the job if it
      // exists in any state; if present, BullMQ already has it.
      const existing = await this.pdfQueue.getJob(job.id);
      if (!existing) {
        await this.pdfQueue.add(RENDER_JOB, { jobId: job.id }, { jobId: job.id });
        count++;
      }
    }
    return count;
  }

  /** Action 2: reset PROCESSING jobs whose worker appears to have died. */
  private async resetStaleProcessing(): Promise<number> {
    const cutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
    const stale = await this.prisma.job.findMany({
      where: { status: 'PROCESSING', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });

    let count = 0;
    for (const job of stale) {
      const queued = await this.pdfQueue.getJob(job.id);
      // If BullMQ still has an active job for it, leave it alone — the worker
      // may just be slow. Only recover if the queue has no record.
      if (queued) {
        const state = await queued.getState();
        if (state === 'active' || state === 'waiting' || state === 'delayed') {
          continue;
        }
      }

      // Reset to PENDING and re-enqueue.
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'PENDING' },
      });
      // Remove any stale queue record so the re-add is fresh.
      await queued?.remove().catch(() => undefined);
      await this.pdfQueue.add(RENDER_JOB, { jobId: job.id }, { jobId: job.id });
      count++;
    }
    return count;
  }

  /** Action 3: retry finalization for batches stuck in FINALIZING. */
  private async retryStuckFinalizing(): Promise<number> {
    const cutoff = new Date(Date.now() - FINALIZING_TIMEOUT_MS);
    const stuck = await this.prisma.batch.findMany({
      where: { status: 'FINALIZING', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });

    let count = 0;
    for (const batch of stuck) {
      // Revert FINALIZING → PROCESSING so tryFinalize can re-claim it.
      await this.prisma.batch.update({
        where: { id: batch.id },
        data: { status: 'PROCESSING' },
      });
      // Re-drive finalization. onChildJobDone re-checks the counts and
      // re-claims. We pass a no-op success for a job that's already counted
      // by calling the public retry path instead.
      await this.batchesService.retryFinalization(batch.id);
      count++;
    }
    return count;
  }
}
