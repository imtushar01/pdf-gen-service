/**
 * error-classification.ts
 *
 * Decides whether a rendering error is RETRYABLE (worth another attempt)
 * or TERMINAL (no point retrying — fail fast).
 *
 * WHY THIS MATTERS:
 * The assessment warns: "Do not mark a job terminally failed on the first
 * retryable exception." A Chromium timeout or a brief Redis hiccup might
 * succeed on retry. But invalid document data will NEVER succeed no matter
 * how many times we retry — retrying just wastes compute and delays the
 * inevitable FAILED status.
 *
 * HOW BULLMQ USES THIS:
 * - If we throw an ordinary error, BullMQ retries (up to `attempts`).
 * - If we want to stop retrying immediately, BullMQ provides
 *   UnrecoverableError — throwing it tells BullMQ "do not retry this".
 *
 * The processor uses classifyError() to decide which to throw.
 */

/**
 * Terminal errors: retrying cannot help. Typically caused by bad input
 * that was somehow persisted, or a permanently missing snapshot.
 */
const TERMINAL_PATTERNS = [
  /validation failed/i,
  /snapshot .* not found/i,
  /invalid document/i,
  /unsupported document type/i,
];

/**
 * Retryable errors: a transient condition that may clear on retry.
 * Chromium timeouts, OOM during a spike, temporary Redis/DB blips.
 */
const RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /navigation/i,
  /out of memory/i,
  /oom/i,
  /target closed/i,
  /connection .* closed/i,
  /econnrefused/i,
  /socket hang up/i,
];

export type ErrorClass = 'retryable' | 'terminal';

export function classifyError(err: unknown): ErrorClass {
  const message = err instanceof Error ? err.message : String(err);

  // Terminal patterns take priority — if the input is bad, never retry.
  for (const pattern of TERMINAL_PATTERNS) {
    if (pattern.test(message)) {
      return 'terminal';
    }
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return 'retryable';
    }
  }

  // Default: treat unknown errors as retryable ONCE via BullMQ's attempt
  // mechanism. BullMQ caps total attempts, so an unknown persistent error
  // still terminates after `attempts` tries — it won't loop forever.
  return 'retryable';
}
