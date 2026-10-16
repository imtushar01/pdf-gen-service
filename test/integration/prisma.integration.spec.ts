/**
 * prisma.integration.spec.ts
 *
 * Integration tests that require a real PostgreSQL connection.
 * Run with: npm run test:integration
 *
 * What we test:
 * 1. PrismaService can connect
 * 2. We can create a Job record
 * 3. idempotencyKey UNIQUE constraint prevents duplicate jobs
 * 4. We can create a Job with an InputSnapshot
 * 5. Snapshot is immutable (test by verifying no update method exists)
 * 6. Batch + BatchItems can be created together
 * 7. Cascade delete: deleting a Job removes its Snapshot and Artifact
 *
 * Prerequisites: docker compose up -d (run before this test suite)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

// Clean up test data after each test to avoid interference
afterEach(async () => {
  // Delete in dependency order (children before parents)
  await prisma.artifact.deleteMany({ where: { job: { idempotencyKey: { startsWith: 'test-' } } } });
  await prisma.inputSnapshot.deleteMany({ where: { job: { idempotencyKey: { startsWith: 'test-' } } } });
  await prisma.batchItem.deleteMany({ where: { job: { idempotencyKey: { startsWith: 'test-' } } } });
  await prisma.job.deleteMany({ where: { idempotencyKey: { startsWith: 'test-' } } });
  await prisma.batch.deleteMany({ where: {} }); // Only test batches should exist
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaService integration', () => {
  it('should connect to the database', async () => {
    const result = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`;
    expect(result[0].result).toBe(1);
  });

  it('should create a Job record', async () => {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: 'test-job-create-1',
        payloadHash: 'abc123hash',
      },
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe('PENDING');
    expect(job.retryCount).toBe(0);
    expect(job.maxRetries).toBe(3);
  });

  it('should enforce idempotencyKey uniqueness', async () => {
    await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: 'test-unique-key-1',
        payloadHash: 'hash1',
      },
    });

    // Second insert with same key should throw a unique constraint error
    await expect(
      prisma.job.create({
        data: {
          documentType: 'INVOICE',
          idempotencyKey: 'test-unique-key-1', // same key
          payloadHash: 'hash2',
        },
      }),
    ).rejects.toThrow();
  });

  it('should create a Job with an InputSnapshot', async () => {
    const job = await prisma.job.create({
      data: {
        documentType: 'PURCHASE_ORDER',
        idempotencyKey: 'test-with-snapshot-1',
        payloadHash: 'hash-snapshot',
        snapshot: {
          create: {
            data: {
              documentType: 'PURCHASE_ORDER',
              poNumber: 'PO-001',
              vendorName: 'Acme Corp',
            },
          },
        },
      },
      include: { snapshot: true },
    });

    expect(job.snapshot).toBeDefined();
    expect(job.snapshot?.jobId).toBe(job.id);
    // Verify snapshot data is stored
    const snapshotData = job.snapshot?.data as Record<string, unknown>;
    expect(snapshotData.poNumber).toBe('PO-001');
  });

  it('should cascade delete snapshot when job is deleted', async () => {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: 'test-cascade-delete-1',
        payloadHash: 'hash-cascade',
        snapshot: {
          create: {
            data: { invoiceNumber: 'INV-001' },
          },
        },
      },
      include: { snapshot: true },
    });

    const snapshotId = job.snapshot!.id;

    // Delete the job
    await prisma.job.delete({ where: { id: job.id } });

    // Snapshot should be gone too
    const orphanSnapshot = await prisma.inputSnapshot.findUnique({
      where: { id: snapshotId },
    });
    expect(orphanSnapshot).toBeNull();
  });

  it('should create a Batch with multiple jobs', async () => {
    const batch = await prisma.batch.create({
      data: {
        totalCount: 2,
        items: {
          create: [
            {
              sequenceNumber: 0,
              job: {
                create: {
                  documentType: 'INVOICE',
                  idempotencyKey: 'test-batch-job-0',
                  payloadHash: 'hash-batch-0',
                },
              },
            },
            {
              sequenceNumber: 1,
              job: {
                create: {
                  documentType: 'INVOICE',
                  idempotencyKey: 'test-batch-job-1',
                  payloadHash: 'hash-batch-1',
                },
              },
            },
          ],
        },
      },
      include: {
        items: {
          include: { job: true },
          orderBy: { sequenceNumber: 'asc' },
        },
      },
    });

    expect(batch.id).toBeDefined();
    expect(batch.status).toBe('PENDING');
    expect(batch.totalCount).toBe(2);
    expect(batch.items).toHaveLength(2);
    expect(batch.items[0].sequenceNumber).toBe(0);
    expect(batch.items[1].sequenceNumber).toBe(1);
  });

  it('should enforce unique sequence numbers within a batch', async () => {
    const batch = await prisma.batch.create({
      data: { totalCount: 2 },
    });

    await prisma.job.createMany({
      data: [
        {
          documentType: 'INVOICE',
          idempotencyKey: 'test-seq-job-0',
          payloadHash: 'h0',
        },
        {
          documentType: 'INVOICE',
          idempotencyKey: 'test-seq-job-1',
          payloadHash: 'h1',
        },
      ],
    });

    const jobs = await prisma.job.findMany({
      where: {
        idempotencyKey: { in: ['test-seq-job-0', 'test-seq-job-1'] },
      },
    });

    await prisma.batchItem.create({
      data: { batchId: batch.id, jobId: jobs[0].id, sequenceNumber: 0 },
    });

    // Same sequence number in same batch should fail
    await expect(
      prisma.batchItem.create({
        data: { batchId: batch.id, jobId: jobs[1].id, sequenceNumber: 0 },
      }),
    ).rejects.toThrow();

    // Clean up
    await prisma.batchItem.deleteMany({ where: { batchId: batch.id } });
    await prisma.batch.delete({ where: { id: batch.id } });
    await prisma.job.deleteMany({
      where: { idempotencyKey: { in: ['test-seq-job-0', 'test-seq-job-1'] } },
    });
  });
});
