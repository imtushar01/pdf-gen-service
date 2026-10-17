/**
 * filesystem.storage.ts
 *
 * Filesystem implementation of IStorageService.
 * Stores artifacts on local disk under the configured artifacts directory.
 *
 * ── Atomic writes ──────────────────────────────────────────────────────────
 * save() writes to a temp file in a .tmp subdirectory, flushes it, then
 * rename()s it to the final path. rename() within the same filesystem is
 * atomic: readers see either no file or the complete file, never a partial.
 * The temp file is cleaned up on any error.
 *
 * ── Streaming checksum ─────────────────────────────────────────────────────
 * computeChecksum() pipes the file through a SHA-256 hash stream, using
 * constant memory regardless of file size. We also compute the checksum
 * during save() from the in-memory buffer (cheap — we already hold it).
 *
 * ── Path safety ────────────────────────────────────────────────────────────
 * All keys are resolved relative to the artifacts root. We reject any key
 * that resolves outside the root (path traversal defense: a key like
 * "../../etc/passwd" must never escape the artifacts directory).
 *
 * ── Limitations (documented honestly) ──────────────────────────────────────
 * Local filesystem storage is NOT suitable for multiple production instances:
 *   - Files on instance A are invisible to instance B.
 *   - No built-in durability/replication — a disk failure loses data.
 *   - No lifecycle policies (auto-expiry, archival).
 * For production, swap in an S3 adapter implementing the same interface.
 *
 * SOLID — Liskov: this class honors every guarantee in IStorageService.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat, unlink } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import {
  ByteRange,
  IStorageService,
  ObjectStat,
  SaveResult,
} from './storage.interface';

@Injectable()
export class FilesystemStorageService implements IStorageService {
  private readonly logger = new Logger(FilesystemStorageService.name);
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(private readonly configService: ConfigService) {
    const configured =
      this.configService.get<string>('artifactsDir') ?? './artifacts';
    this.root = resolve(configured);
    this.tmpDir = join(this.root, '.tmp');
  }

  /**
   * Resolve a key to an absolute path and ensure it stays within root.
   * Throws if the key would escape the artifacts directory.
   */
  private resolveKey(key: string): string {
    const abs = resolve(this.root, key);
    // abs must be the root itself or inside it
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`Invalid storage key (path traversal): ${key}`);
    }
    return abs;
  }

  async save(key: string, data: Buffer): Promise<SaveResult> {
    const finalPath = this.resolveKey(key);

    // Ensure the destination directory and tmp directory exist
    await mkdir(dirname(finalPath), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });

    // Write to a unique temp file first
    const tmpPath = join(this.tmpDir, `${randomUUID()}.tmp`);

    try {
      await this.writeBufferToFile(tmpPath, data);

      // Atomic move into place
      await rename(tmpPath, finalPath);

      const sha256 = createHash('sha256').update(data).digest('hex');

      this.logger.log(
        `Saved artifact ${key} (${data.length} bytes, sha256=${sha256.slice(0, 12)}...)`,
      );

      return { key, sha256, sizeBytes: data.length };
    } catch (err) {
      // Clean up the temp file on any failure
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  private writeBufferToFile(path: string, data: Buffer): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const stream = createWriteStream(path);
      stream.on('error', reject);
      stream.on('finish', resolvePromise);
      stream.end(data);
    });
  }

  async createReadStream(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.resolveKey(key);
    if (!(await this.exists(key))) {
      throw new NotFoundException(`Artifact not found: ${key}`);
    }

    if (range) {
      return createReadStream(path, { start: range.start, end: range.end });
    }
    return createReadStream(path);
  }

  async stat(key: string): Promise<ObjectStat> {
    const path = this.resolveKey(key);
    try {
      const s = await stat(path);
      return { sizeBytes: s.size };
    } catch {
      throw new NotFoundException(`Artifact not found: ${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolveKey(key);
    // rm with force: true is idempotent — no error if the file is missing
    await rm(path, { force: true });
  }

  async computeChecksum(key: string): Promise<string> {
    const path = this.resolveKey(key);
    if (!(await this.exists(key))) {
      throw new NotFoundException(`Artifact not found: ${key}`);
    }

    return new Promise<string>((resolvePromise, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolvePromise(hash.digest('hex')));
    });
  }
}
