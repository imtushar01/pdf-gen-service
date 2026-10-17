/**
 * fingerprint.util.ts
 *
 * Produces a stable SHA-256 fingerprint of a JSON payload.
 *
 * WHY CANONICAL JSON?
 * JSON.stringify does not guarantee key order. These two objects are
 * logically identical but stringify to different strings:
 *   { a: 1, b: 2 }  →  '{"a":1,"b":2}'
 *   { b: 2, a: 1 }  →  '{"b":2,"a":1}'
 * Different strings → different SHA-256 → we'd think the payload changed
 * when it didn't.
 *
 * To fix this, we recursively sort object keys before stringifying.
 * Arrays keep their order (order matters in arrays — a list of line items
 * in a different order IS a different document).
 *
 * This fingerprint is used for idempotency: if a caller reuses an
 * idempotency key, we compare fingerprints to decide whether it's a
 * legitimate retry (same payload) or a conflict (different payload).
 */
import { createHash } from 'crypto';

/**
 * Recursively sort object keys to produce a canonical representation.
 * Arrays preserve their order; only object keys are sorted.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute a stable SHA-256 hex fingerprint of a JSON-serializable payload.
 */
export function fingerprintPayload(payload: unknown): string {
  const canonical = canonicalize(payload);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
