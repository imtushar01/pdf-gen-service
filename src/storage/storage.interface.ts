/**
 * storage.interface.ts
 *
 * The contract every storage backend must honor.
 *
 * SOLID — Dependency Inversion:
 * High-level code (the worker, download controller) depends on this
 * interface, not on the filesystem or S3 directly. We can swap the
 * implementation without touching the business logic.
 *
 * SOLID — Open/Closed:
 * Adding a new backend (S3, MinIO, GCS) means writing a new class that
 * implements this interface. No existing code changes.
 *
 * SOLID — Liskov Substitution:
 * Any implementation MUST honor these behavioral guarantees:
 *   - save() writes atomically: a reader either sees the complete file or
 *     no file at all. Partial writes must never be observable at the key.
 *   - save() returns the SHA-256 checksum and byte size of what was stored.
 *   - createReadStream() throws if the key does not exist.
 *   - createReadStream(key, range) returns exactly the requested byte range.
 *   - exists() returns false (never throws) for a missing key.
 *   - delete() is idempotent: deleting a missing key does not throw.
 *
 * THE RUNTIME TOKEN:
 * TypeScript interfaces are erased at compile time — they don't exist at
 * runtime, so NestJS cannot use `IStorageService` as a DI token. We export
 * a string token (STORAGE_SERVICE) and bind it to the concrete class in
 * the module provider. Consumers inject with @Inject(STORAGE_SERVICE).
 */
import type { Readable } from 'stream';

/** Injection token used to bind IStorageService to an implementation. */
export const STORAGE_SERVICE = 'STORAGE_SERVICE';

/** A byte range for partial reads (HTTP Range support, Milestone 6). */
export interface ByteRange {
  /** First byte offset, inclusive (0-based). */
  start: number;
  /** Last byte offset, inclusive. */
  end: number;
}

/** Result of a successful save. */
export interface SaveResult {
  /** Relative storage key, e.g. "pdfs/<uuid>.pdf". */
  key: string;
  /** SHA-256 hex digest of the stored bytes. */
  sha256: string;
  /** Total size in bytes. */
  sizeBytes: number;
}

/** Metadata about a stored object. */
export interface ObjectStat {
  sizeBytes: number;
}

export interface IStorageService {
  /**
   * Store a buffer atomically under the given key.
   * Computes and returns the SHA-256 checksum and byte size.
   * Must NOT leave a partial file observable at the key on failure.
   */
  save(key: string, data: Buffer): Promise<SaveResult>;

  /**
   * Open a read stream for the object.
   * If `range` is provided, the stream yields only those bytes.
   * Throws if the key does not exist.
   */
  createReadStream(key: string, range?: ByteRange): Promise<Readable>;

  /** Return object metadata (size). Throws if the key does not exist. */
  stat(key: string): Promise<ObjectStat>;

  /** Return true if an object exists at the key. Never throws for missing. */
  exists(key: string): Promise<boolean>;

  /** Delete the object. Idempotent — deleting a missing key does not throw. */
  delete(key: string): Promise<void>;

  /**
   * Compute the SHA-256 checksum of a stored object by streaming it.
   * Does NOT load the whole object into memory.
   * Used for integrity verification.
   */
  computeChecksum(key: string): Promise<string>;
}
