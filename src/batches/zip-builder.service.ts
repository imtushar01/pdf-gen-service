/**
 * zip-builder.service.ts
 *
 * Builds a ZIP archive of a batch's PDFs, streaming to avoid loading all
 * PDFs into memory at once.
 *
 * ── Backpressure ───────────────────────────────────────────────────────────
 * archiver produces compressed bytes as it reads each PDF. We pipe archiver
 * into a filesystem write stream. Node's stream pipeline applies backpressure
 * automatically: if the disk can't keep up, archiver pauses. We never hold
 * all 100 PDFs in memory — each is streamed in, compressed, and written out.
 *
 * ── Error handling ─────────────────────────────────────────────────────────
 * archiver emits 'error' on failure (e.g. a source PDF disappears). We reject
 * the promise and the temp ZIP is cleaned up by the caller. We also listen
 * for 'warning' (non-fatal, e.g. a missing optional file) and log it.
 *
 * ── Failure manifest ───────────────────────────────────────────────────────
 * If some child jobs failed, we embed a `failures.json` inside the ZIP so the
 * recipient knows exactly which documents are missing and why — successful
 * PDFs are never lost because of a few failures.
 *
 * SOLID — Single Responsibility: this service only assembles ZIPs. It reads
 * PDF bytes via IStorageService and writes the ZIP via a stream the caller
 * provides. It does not touch the database or decide batch status.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
// archiver is a CommonJS module that exports a callable directly.
// Use `import = require` so `archiver(...)` resolves to the function, not
// an object with a `.default` property.
import archiver = require('archiver');
import { createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { ConfigService } from '@nestjs/config';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../storage/storage.interface';

export interface ZipEntry {
  /** Filename inside the ZIP, e.g. "invoice-001.pdf". */
  filename: string;
  /** Storage key of the source PDF. */
  storageKey: string;
}

export interface FailureManifestEntry {
  sequenceNumber: number;
  documentType: string;
  error: string;
}

export interface ZipBuildResult {
  /** Storage key of the finished ZIP. */
  key: string;
  sha256: string;
  sizeBytes: number;
}

@Injectable()
export class ZipBuilderService {
  private readonly logger = new Logger(ZipBuilderService.name);
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(STORAGE_SERVICE)
    private readonly storage: IStorageService,
  ) {
    this.root = resolve(
      this.configService.get<string>('artifactsDir') ?? './artifacts',
    );
    this.tmpDir = join(this.root, '.tmp');
  }

  /**
   * Build a ZIP for a batch.
   * Writes to a temp file first, then atomically renames into place — the
   * same atomic-write discipline as artifact storage, so a crash mid-build
   * never leaves a partial ZIP at the final key.
   */
  async buildBatchZip(
    batchId: string,
    entries: ZipEntry[],
    failures: FailureManifestEntry[],
  ): Promise<ZipBuildResult> {
    const key = `zips/${batchId}.zip`;
    const finalPath = resolve(this.root, key);
    const tmpPath = join(this.tmpDir, `${randomUUID()}.zip.tmp`);

    await mkdir(dirname(finalPath), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });

    try {
      await this.writeZip(tmpPath, entries, failures);

      // Atomic move into place
      await rename(tmpPath, finalPath);

      // Compute checksum + size by streaming the finished file
      const { sha256, sizeBytes } = await this.hashFile(finalPath);

      this.logger.log(
        `Built ZIP for batch ${batchId}: ${entries.length} PDFs, ` +
          `${failures.length} failures, ${sizeBytes} bytes`,
      );

      return { key, sha256, sizeBytes };
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Stream all entries into a ZIP file at tmpPath.
   * Resolves when the archive is fully flushed to disk.
   */
  private writeZip(
    tmpPath: string,
    entries: ZipEntry[],
    failures: FailureManifestEntry[],
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(tmpPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        archive.destroy();
        output.destroy();
        reject(err);
      };

      // 'close' fires when all data has been flushed to disk
      output.on('close', () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });

      output.on('error', fail);
      archive.on('error', fail);
      archive.on('warning', (warn) => {
        this.logger.warn(`archiver warning: ${warn.message}`);
      });

      // Pipe archive → file. Node applies backpressure automatically.
      archive.pipe(output);

      // Append each PDF as a read stream (not a buffer) — streamed, not
      // loaded into memory.
      void this.appendEntries(archive, entries, failures).catch(fail);
    });
  }

  private async appendEntries(
    archive: archiver.Archiver,
    entries: ZipEntry[],
    failures: FailureManifestEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const stream = await this.storage.createReadStream(entry.storageKey);
      archive.append(stream, { name: entry.filename });
    }

    // Embed the failure manifest if any items failed
    if (failures.length > 0) {
      const manifest = JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          failedCount: failures.length,
          failures,
        },
        null,
        2,
      );
      archive.append(Buffer.from(manifest, 'utf8'), { name: 'failures.json' });
    }

    // Finalize — no more entries. This triggers the 'close' event once
    // everything is flushed.
    await archive.finalize();
  }

  private hashFile(
    path: string,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash('sha256');
      let size = 0;
      const stream = createReadStream(path);
      stream.on('error', reject);
      stream.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buf.length;
        hash.update(buf);
      });
      stream.on('end', () =>
        resolvePromise({ sha256: hash.digest('hex'), sizeBytes: size }),
      );
    });
  }
}
