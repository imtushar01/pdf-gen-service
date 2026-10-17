/**
 * range.util.spec.ts
 *
 * Exhaustive unit tests for HTTP Range parsing.
 * This is pure logic, so we test every edge case the assessment calls out:
 * valid ranges, suffix ranges, invalid ranges, empty files, unsatisfiable
 * ranges, and open-ended ranges.
 */
import { parseRange } from './range.util';

describe('parseRange', () => {
  const SIZE = 1000; // pretend the file is 1000 bytes (indices 0..999)

  describe('no range header → full file', () => {
    it('returns full for undefined', () => {
      expect(parseRange(undefined, SIZE)).toEqual({ type: 'full' });
    });
    it('returns full for empty string', () => {
      expect(parseRange('', SIZE)).toEqual({ type: 'full' });
    });
    it('returns full for whitespace', () => {
      expect(parseRange('   ', SIZE)).toEqual({ type: 'full' });
    });
  });

  describe('valid closed ranges', () => {
    it('bytes=0-499 → first 500 bytes', () => {
      expect(parseRange('bytes=0-499', SIZE)).toEqual({
        type: 'satisfiable',
        start: 0,
        end: 499,
      });
    });
    it('bytes=500-999 → second half', () => {
      expect(parseRange('bytes=500-999', SIZE)).toEqual({
        type: 'satisfiable',
        start: 500,
        end: 999,
      });
    });
    it('bytes=0-0 → single byte', () => {
      expect(parseRange('bytes=0-0', SIZE)).toEqual({
        type: 'satisfiable',
        start: 0,
        end: 0,
      });
    });
  });

  describe('open-ended ranges', () => {
    it('bytes=500- → from 500 to end', () => {
      expect(parseRange('bytes=500-', SIZE)).toEqual({
        type: 'satisfiable',
        start: 500,
        end: 999,
      });
    });
    it('bytes=0- → whole file', () => {
      expect(parseRange('bytes=0-', SIZE)).toEqual({
        type: 'satisfiable',
        start: 0,
        end: 999,
      });
    });
  });

  describe('suffix ranges', () => {
    it('bytes=-500 → last 500 bytes', () => {
      expect(parseRange('bytes=-500', SIZE)).toEqual({
        type: 'satisfiable',
        start: 500,
        end: 999,
      });
    });
    it('bytes=-1 → last byte', () => {
      expect(parseRange('bytes=-1', SIZE)).toEqual({
        type: 'satisfiable',
        start: 999,
        end: 999,
      });
    });
    it('suffix larger than file → whole file', () => {
      expect(parseRange('bytes=-5000', SIZE)).toEqual({
        type: 'satisfiable',
        start: 0,
        end: 999,
      });
    });
  });

  describe('clamping', () => {
    it('end beyond EOF is clamped to last byte', () => {
      expect(parseRange('bytes=900-99999', SIZE)).toEqual({
        type: 'satisfiable',
        start: 900,
        end: 999,
      });
    });
  });

  describe('unsatisfiable ranges', () => {
    it('start beyond EOF → unsatisfiable', () => {
      expect(parseRange('bytes=1000-', SIZE)).toEqual({
        type: 'unsatisfiable',
      });
      expect(parseRange('bytes=5000-6000', SIZE)).toEqual({
        type: 'unsatisfiable',
      });
    });
    it('any range on an empty file → unsatisfiable', () => {
      expect(parseRange('bytes=0-100', 0)).toEqual({ type: 'unsatisfiable' });
      expect(parseRange('bytes=-10', 0)).toEqual({ type: 'unsatisfiable' });
    });
  });

  describe('invalid / malformed ranges → ignored (serve full)', () => {
    it('non-bytes unit', () => {
      expect(parseRange('items=0-5', SIZE)).toEqual({ type: 'invalid' });
    });
    it('multiple ranges (not supported)', () => {
      expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({
        type: 'invalid',
      });
    });
    it('end before start', () => {
      expect(parseRange('bytes=500-100', SIZE)).toEqual({ type: 'invalid' });
    });
    it('negative start', () => {
      expect(parseRange('bytes=abc-def', SIZE)).toEqual({ type: 'invalid' });
    });
    it('bare dash', () => {
      expect(parseRange('bytes=-', SIZE)).toEqual({ type: 'invalid' });
    });
    it('no dash', () => {
      expect(parseRange('bytes=500', SIZE)).toEqual({ type: 'invalid' });
    });
    it('non-integer suffix', () => {
      expect(parseRange('bytes=-abc', SIZE)).toEqual({ type: 'invalid' });
    });
  });
});
