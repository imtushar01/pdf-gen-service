/**
 * pdf.processor.ts
 *
 * The BullMQ consumer that renders PDFs.
 *
 * FLOW for each job:
 *   1. Load the job and its immutable snapshot from the database.
 *   2. IDEMPOTENCY CHECK: if the job is already COMPLETED with an artifact,
 *      acknowledge and exit (handles duplicate queue deliveries + the
 *      "crash after save, before status update" case).
 *   3. Mark the job PROCESSING.
 *   4. Validate the snapshot data (defense in depth — it was validated at
 *      acceptance, but we re-validate to be safe).
 *   5. Render the PDF (bounded concurrency inside RendererService).
 *   6. Save the artifact (atomic write + checksum + metadata).
 *   7. Mark the job COMPLETED.
 *
 * RETRY vs TERMINAL:
 *   - On a terminal error (bad data), throw UnrecoverableError → BullMQ
 *     stops retrying immediately. We record FAILED.
 *   - On a retryable error, throw a normal Error → BullMQ retries with
 *     backoff. We only record FAILED when attempts are exhausted
 *     (handled in the 'failed' event listener).
 *
 * CONCURRENCY:
 *   The @Processor concurrency option bounds how many jobs this worker
 *   handles in parallel. Combined with the semaphore inside RendererService,
 *   this keeps Chromium memory bounded.
 *
 * SOLID — Single Responsibility: this processor orchestrates the render
 * pipeline. It delegates rendering, storage, and persistence to their
 * respective services.
 */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job as BullJob, UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RendererService } from '../renderer/renderer.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { DocumentValidationService } from '../documents/document-validation.service';
import { DocumentType } from '../documents/dto/create-job.dto';
import { PDF_QUEUE, RenderJobData } from './queue.constants';
import { classifyError } from './error-classification';
import { BatchesService } from '../batches/batches.service';

@Processor(PDF_QUEUE, {
  // Bounded concurrency — how many jobs this worker renders in parallel.
  // Read from config so it can be tuned per environment.
  concurrency: parseInt(process.env.RENDER_CONCURRENCY ?? '4', 10),
})
export class PdfProcessor extends WorkerHost {
  private readonly logger = new Logger(PdfProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: RendererService,
    private readonly artifactService: ArtifactService,
    private readonly validation: DocumentValidationService,
    private readonly config: ConfigService,
    private readonly batchesService: BatchesService,
  ) {
    super();
  }

  async process(job: BullJob<RenderJobData>): Promise<void> {
    const { jobId } = job.data;
    this.logger.log(
      `Processing render job ${jobId} (attempt ${job.attemptsMade + 1})`,
    );

    // Step 1: Load job + snapshot
    const dbJob = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { snapshot: true, artifact: true },
    });

    if (!dbJob) {
      // The job row is gone — nothing to render. Terminal.
      throw new UnrecoverableError(`Job ${jobId} not found in database`);
    }

    // Step 2: Idempotency — already done?
    if (dbJob.status === 'COMPLETED' && dbJob.artifact) {
      this.logger.log(
        `Job ${jobId} already completed with an artifact — skipping (idempotent)`,
      );
      return;
    }

    if (!dbJob.snapshot) {
      throw new UnrecoverableError(`Snapshot for job ${jobId} not found`);
    }

    try {
      // Step 3: Mark PROCESSING
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'PROCESSING', retryCount: job.attemptsMade },
      });

      // Step 4: Validate the frozen snapshot (defense in depth)
      const validated = await this.validation.validateDocument(
        dbJob.documentType as DocumentType,
        dbJob.snapshot.data as Record<string, unknown>,
      );

      // Step 5: Render
      const { pdfBuffer } = await this.renderer.render(validated);

      // Step 6: Save artifact (idempotent — handle duplicate gracefully)
      await this.saveArtifactIdempotent(jobId, pdfBuffer);

      // Step 7: Mark COMPLETED
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      this.logger.log(`Job ${jobId} completed`);

      // Notify the batch (no-op if this isn't a batch job).
      await this.batchesService.onChildJobDone(jobId, true);
    } catch (err) {
      const errorClass = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn(
        `Job ${jobId} failed (${errorClass}): ${message}`,
      );

      if (errorClass === 'terminal') {
        // Record the failure now and tell BullMQ not to retry.
        await this.markFailed(jobId, message);
        // Notify the batch of a terminal child failure.
        await this.batchesService.onChildJobDone(jobId, false);
        throw new UnrecoverableError(message);
      }

      // Retryable: record the error message but keep status PROCESSING so a
      // retry can resume. BullMQ will retry; if attempts are exhausted, the
      // 'failed' event handler marks the job FAILED.
      await this.prisma.job
        .update({
          where: { id: jobId },
          data: { errorMessage: message, retryCount: job.attemptsMade + 1 },
        })
        .catch(() => undefined);

      throw err; // normal error → BullMQ retries with backoff
    }
  }

  /**
   * Save the artifact, tolerating the case where a previous attempt already
   * saved it (unique constraint on Artifact.jobId). This makes the step
   * safe to re-run after a crash between save and status update.
   */
  private async saveArtifactIdempotent(
    jobId: string,
    pdf: Buffer,
  ): Promise<void> {
    const existing = await this.artifactService.getByJobId(jobId);
    if (existing) {
      this.logger.log(
        `Artifact for job ${jobId} already exists — skipping save`,
      );
      return;
    }
    await this.artifactService.saveJobArtifact(jobId, pdf);
  }

  private async markFailed(jobId: string, message: string): Promise<void> {
    await this.prisma.job
      .update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: message },
      })
      .catch(() => undefined);
  }

  /**
   * Fired when BullMQ gives up after exhausting all retry attempts.
   * This is where a retryable error finally becomes a terminal FAILED.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: BullJob<RenderJobData>, err: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `Job ${job.data.jobId} exhausted ${maxAttempts} attempts — marking FAILED`,
      );
      await this.markFailed(job.data.jobId, err.message);
      // A retryable job that finally gave up is a terminal failure for its
      // batch. Notify so the batch can finalize. Guard against double-count:
      // onChildJobDone is only called here (exhausted) OR in the terminal
      // branch of process(), never both, because UnrecoverableError does not
      // re-enter the retry path.
      await this.batchesService.onChildJobDone(job.data.jobId, false);
    }
  }
}
