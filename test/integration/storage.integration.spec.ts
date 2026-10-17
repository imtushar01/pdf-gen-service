/**
 * storage.integration.spec.ts
 *
 * Integration tests for FilesystemStorageService using a real temp directory.
 *
 * What we test:
 * 1. save() writes the file and returns correct sha256 + size
 * 2. The saved checksum matches an independent hash of the data
 * 3. exists() returns true after save, false before
 * 4. createReadStream() returns the full file content
 * 5. createReadStream() with a range returns only those bytes
 * 6. computeChecksum() (streaming) matches the save() checksum
 * 7. delete() is idempotent (no error for missing key)
 * 8. path traversal keys are rejected
 * 9. ArtifactService persists metadata and verifies checksums
 */
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { FilesystemStorageService } from '../../src/storage/filesystem.storage';
import { ArtifactService } from '../../src/artifacts/artifact.service';
import { STORAGE_SERVICE } from '../../src/storage/storage.interface';

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

describe('FilesystemStorageService (integration)', () => {
  let storage: FilesystemStorageService;
  let tempRoot: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pdf-storage-test-'));
    const config = {
      get: jest.fn((key: string) =>
        key === 'artifactsDir' ? tempRoot : undefined,
      ),
    } as unknown as ConfigService;
    storage = new FilesystemStorageService(config);
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const sampleData = Buffer.from('%PDF-1.4 fake pdf content for testing');

  it('should save a file and return correct checksum and size', async () => {
    const result = await storage.save('pdfs/test-1.pdf', sampleData);

    expect(result.key).toBe('pdfs/test-1.pdf');
    expect(result.sizeBytes).toBe(sampleData.length);

    const expectedHash = createHash('sha256').update(sampleData).digest('hex');
    expect(result.sha256).toBe(expectedHash);
  });

  it('should report existence correctly', async () => {
    expect(await storage.exists('pdfs/not-there.pdf')).toBe(false);
    await storage.save('pdfs/exists-test.pdf', sampleData);
    expect(await storage.exists('pdfs/exists-test.pdf')).toBe(true);
  });

  it('should read back the full file content', async () => {
    await storage.save('pdfs/read-test.pdf', sampleData);
    const stream = await storage.createReadStream('pdfs/read-test.pdf');
    const content = await streamToBuffer(stream);
    expect(content.equals(sampleData)).toBe(true);
  });

  it('should return only the requested byte range', async () => {
    const data = Buffer.from('0123456789');
    await storage.save('pdfs/range-test.pdf', data);

    // bytes 2-5 inclusive → "2345"
    const stream = await storage.createReadStream('pdfs/range-test.pdf', {
      start: 2,
      end: 5,
    });
    const content = await streamToBuffer(stream);
    expect(content.toString()).toBe('2345');
  });

  it('should compute a streaming checksum matching the save checksum', async () => {
    const saved = await storage.save('pdfs/checksum-test.pdf', sampleData);
    const computed = await storage.computeChecksum('pdfs/checksum-test.pdf');
    expect(computed).toBe(saved.sha256);
  });

  it('should report size via stat()', async () => {
    await storage.save('pdfs/stat-test.pdf', sampleData);
    const s = await storage.stat('pdfs/stat-test.pdf');
    expect(s.sizeBytes).toBe(sampleData.length);
  });

  it('should delete idempotently (no error for missing key)', async () => {
    await storage.save('pdfs/delete-test.pdf', sampleData);
    await storage.delete('pdfs/delete-test.pdf');
    expect(await storage.exists('pdfs/delete-test.pdf')).toBe(false);
    // Deleting again must not throw
    await expect(storage.delete('pdfs/delete-test.pdf')).resolves.toBeUndefined();
  });

  it('should reject path traversal keys', async () => {
    await expect(
      storage.save('../../etc/evil.pdf', sampleData),
    ).rejects.toThrow(/path traversal/);
  });

  it('should throw when reading a non-existent key', async () => {
    await expect(
      storage.createReadStream('pdfs/missing.pdf'),
    ).rejects.toThrow();
  });
});

describe('ArtifactService (integration)', () => {
  let artifactService: ArtifactService;
  let storage: FilesystemStorageService;
  let prisma: PrismaClient;
  let tempRoot: string;
  const testJobIds: string[] = [];

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pdf-artifact-test-'));
    const config = {
      get: jest.fn((key: string) =>
        key === 'artifactsDir' ? tempRoot : undefined,
      ),
    } as unknown as ConfigService;
    storage = new FilesystemStorageService(config);
    prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    artifactService = new ArtifactService(
      prisma as never,
      storage,
    );
  });

  afterAll(async () => {
    for (const id of testJobIds) {
      await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function makeJob(): Promise<string> {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: `test-artifact-${Date.now()}-${Math.random()}`,
        payloadHash: 'hash',
      },
    });
    testJobIds.push(job.id);
    return job.id;
  }

  const pdf = Buffer.from('%PDF-1.4 artifact service test content');

  it('should save an artifact and persist metadata', async () => {
    const jobId = await makeJob();
    const artifact = await artifactService.saveJobArtifact(jobId, pdf);

    expect(artifact.jobId).toBe(jobId);
    expect(artifact.sizeBytes).toBe(pdf.length);
    expect(artifact.storagePath).toMatch(/^pdfs\/.*\.pdf$/);
    expect(artifact.sha256).toBe(
      createHash('sha256').update(pdf).digest('hex'),
    );
  });

  it('should verify a valid checksum', async () => {
    const jobId = await makeJob();
    await artifactService.saveJobArtifact(jobId, pdf);

    const result = await artifactService.verifyChecksum(jobId);
    expect(result.valid).toBe(true);
    expect(result.computedChecksum).toBe(result.storedChecksum);
  });

  it('should detect a tampered file', async () => {
    const jobId = await makeJob();
    const artifact = await artifactService.saveJobArtifact(jobId, pdf);

    // Tamper: overwrite the stored file with different bytes
    await storage.save(artifact.storagePath, Buffer.from('tampered content'));

    const result = await artifactService.verifyChecksum(jobId);
    expect(result.valid).toBe(false);
    expect(result.computedChecksum).not.toBe(result.storedChecksum);
  });

  it('should return null for a job with no artifact', async () => {
    const jobId = await makeJob();
    const artifact = await artifactService.getByJobId(jobId);
    expect(artifact).toBeNull();
  });
});
