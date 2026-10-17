/**
 * fingerprint.util.spec.ts
 *
 * Tests the canonical JSON fingerprinting used for idempotency.
 *
 * Critical property: the same logical data must always produce the same
 * hash, regardless of key order. Different data must produce different hashes.
 */
import { fingerprintPayload } from './fingerprint.util';

describe('fingerprintPayload', () => {
  it('should produce the same hash for the same object', () => {
    const a = { invoiceNumber: 'INV-1', total: 100 };
    const b = { invoiceNumber: 'INV-1', total: 100 };
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it('should produce the same hash regardless of key order', () => {
    const a = { invoiceNumber: 'INV-1', total: 100, currency: 'INR' };
    const b = { currency: 'INR', total: 100, invoiceNumber: 'INV-1' };
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it('should produce the same hash for nested objects with different key order', () => {
    const a = { seller: { name: 'Acme', gstin: '123' }, total: 100 };
    const b = { total: 100, seller: { gstin: '123', name: 'Acme' } };
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it('should produce different hashes for different values', () => {
    const a = { total: 100 };
    const b = { total: 200 };
    expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
  });

  it('should treat array order as significant', () => {
    // Line items in a different order IS a different document
    const a = { items: [{ id: 1 }, { id: 2 }] };
    const b = { items: [{ id: 2 }, { id: 1 }] };
    expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
  });

  it('should return a 64-character hex string (SHA-256)', () => {
    const hash = fingerprintPayload({ test: 'data' });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should handle null and primitive values', () => {
    expect(fingerprintPayload(null)).toBe(fingerprintPayload(null));
    expect(fingerprintPayload(42)).toBe(fingerprintPayload(42));
    expect(fingerprintPayload('string')).toBe(fingerprintPayload('string'));
  });
});
