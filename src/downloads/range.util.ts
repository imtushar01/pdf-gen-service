/**
 * range.util.ts
 *
 * Parses a single HTTP Range header against a known content length.
 *
 * We implement a SINGLE-RANGE policy: one range per request. Multipart
 * ranges (bytes=0-99,200-299) are not supported — they are rarely needed
 * and add significant complexity (multipart/byteranges responses).
 *
 * Reference: RFC 7233 (HTTP Range Requests).
 *
 * This is pure logic — no file I/O — so it is fully unit-testable.
 *
 * Supported forms (size = total content length in bytes):
 *   "bytes=0-499"    → bytes 0 through 499 inclusive
 *   "bytes=500-"     → byte 500 through the last byte
 *   "bytes=-500"     → the LAST 500 bytes (suffix range)
 *   "bytes=0-"       → the entire file
 *
 * Return values:
 *   { type: 'full' }                       → no/empty Range: serve whole file (200)
 *   { type: 'satisfiable', start, end }    → serve 206 with these inclusive bounds
 *   { type: 'unsatisfiable' }              → serve 416
 *   { type: 'invalid' }                    → malformed header: ignore, serve whole (200)
 */
export type RangeResult =
  | { type: 'full' }
  | { type: 'satisfiable'; start: number; end: number }
  | { type: 'unsatisfiable' }
  | { type: 'invalid' };

export function parseRange(
  rangeHeader: string | undefined,
  size: number,
): RangeResult {
  if (!rangeHeader || rangeHeader.trim() === '') {
    return { type: 'full' };
  }

  // Only "bytes=" units are supported
  const match = /^bytes=(.*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { type: 'invalid' };
  }

  const spec = match[1].trim();

  // Reject multiple ranges (comma-separated) — single-range policy
  if (spec.includes(',')) {
    return { type: 'invalid' };
  }

  const dashIndex = spec.indexOf('-');
  if (dashIndex === -1) {
    return { type: 'invalid' };
  }

  const startStr = spec.slice(0, dashIndex).trim();
  const endStr = spec.slice(dashIndex + 1).trim();

  // An empty file cannot satisfy any byte range
  if (size === 0) {
    return { type: 'unsatisfiable' };
  }

  // Suffix range: "bytes=-N" → last N bytes
  if (startStr === '') {
    if (endStr === '') {
      return { type: 'invalid' }; // "bytes=-" is malformed
    }
    const suffixLength = Number(endStr);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return { type: 'invalid' };
    }
    // Clamp: if the client asks for more than the file size, give the whole file
    const start = Math.max(0, size - suffixLength);
    return { type: 'satisfiable', start, end: size - 1 };
  }

  // Normal range: "bytes=START-" or "bytes=START-END"
  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0) {
    return { type: 'invalid' };
  }

  // Start beyond the last byte is unsatisfiable
  if (start >= size) {
    return { type: 'unsatisfiable' };
  }

  let end: number;
  if (endStr === '') {
    // Open-ended: to the last byte
    end = size - 1;
  } else {
    end = Number(endStr);
    if (!Number.isInteger(end) || end < start) {
      return { type: 'invalid' };
    }
    // Clamp end to the last byte
    end = Math.min(end, size - 1);
  }

  return { type: 'satisfiable', start, end };
}
