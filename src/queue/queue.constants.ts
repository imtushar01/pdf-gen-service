/**
 * queue.constants.ts
 *
 * Shared names and types for the BullMQ queues.
 * Keeping these in one place prevents typos (a mistyped queue name means
 * the producer and consumer silently use different queues and nothing works).
 */

/** Name of the queue that processes single-document render jobs. */
export const PDF_QUEUE = 'pdf-render';

/** Job name within the queue. */
export const RENDER_JOB = 'render-document';

/**
 * The payload enqueued for each render job.
 * We enqueue only the jobId — NOT the document data. The worker loads the
 * immutable snapshot from the database using this ID. This keeps the queue
 * message small and ensures the worker always renders the frozen snapshot,
 * never stale or mutated data.
 */
export interface RenderJobData {
  jobId: string;
}
