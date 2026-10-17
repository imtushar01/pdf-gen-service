/**
 * recovery.integration.spec.ts
 *
 * Integration tests for the RecoveryService reconciler against real
 * Postgres + Redis.
 *
 * What we test:
 * 1. An orphaned PENDING job (persisted but never enqueued) gets re-enqueued.
 * 2. A recent PENDING job (within grace period) is NOT touched.
 * 3. Re-running the reconciler is idempotent (no duplicate queue entries).
 * 4. A stale PROCESSING job with no queue record is reset to PENDING + requeued.
 *
 * Prerequisites: docker compose up -d
 *
 * NOTE: We construct RecoveryService with a real queue and a stub
 * BatchesService (finalization retry is unit-tested separately).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import configuration from '../../src/config/configuration';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueueModule } from '../../src/queue/queue.module';
import { RecoveryService } from '../../src/recovery/recovery.service';
import { BatchesService } from '../../src/batches/batches.service';
import { PDF_QUEUE } from '../../src/queue/queue.constants';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://pdfuser:pdfpass@localhost:5434/pdfdb';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6380';

describe('RecoveryService (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recovery: RecoveryService;
  let queue: Queue;
  const testJobIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        PrismaModule,
        QueueModule,
      ],
      providers: [
        RecoveryService,
        // Stub BatchesService — recovery's batch path is unit-tested elsewhere
        {
          provide: BatchesService,
          useValue: { retryFinalization: jest.fn() },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    recovery = app.get(RecoveryService);
    queue = app.get<Queue>(getQueueToken(PDF_QUEUE));
  }, 30000);

  afterAll(async () => {
    for (const id of testJobIds) {
      const qjob = await queue.getJob(id);
      await qjob?.remove().catch(() => undefined);
      await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  async function makePendingJob(ageMs: number): Promise<string> {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: `test-recovery-${Date.now()}-${Math.random()}`,
        payloadHash: 'h',
        status: 'PENDING',
        // Backdate createdAt to simulate an old orphan
        createdAt: new Date(Date.now() - ageMs),
        updatedAt: new Date(Date.now() - ageMs),
      },
    });
    testJobIds.push(job.id);
    return job.id;
  }

  it('re-enqueues an orphaned PENDING job', async () => {
    const jobId = await makePendingJob(60_000); // 60s old → past grace

    // Not in the queue yet
    expect(await queue.getJob(jobId)).toBeUndefined();

    await recovery.reconcileNow();

    // Now it should be enqueued
    const queued = await queue.getJob(jobId);
    expect(queued).toBeDefined();
    expect(queued!.id).toBe(jobId);
  }, 30000);

  it('does NOT re-enqueue a recent PENDING job (within grace period)', async () => {
    const jobId = await makePendingJob(1_000); // 1s old → within grace

    await recovery.reconcileNow();

    const queued = await queue.getJob(jobId);
    expect(queued).toBeUndefined();
  }, 30000);

  it('is idempotent: re-running does not create duplicate queue entries', async () => {
    const jobId = await makePendingJob(60_000);

    await recovery.reconcileNow();
    const first = await queue.getJob(jobId);
    expect(first).toBeDefined();

    // Run again — must not throw, must not duplicate
    await recovery.reconcileNow();
    const second = await queue.getJob(jobId);
    expect(second!.id).toBe(first!.id);
  }, 30000);

  it('resets a stale PROCESSING job with no queue record to PENDING and requeues', async () => {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: `test-recovery-stale-${Date.now()}`,
        payloadHash: 'h',
        status: 'PROCESSING',
        createdAt: new Date(Date.now() - 300_000),
        updatedAt: new Date(Date.now() - 300_000), // 5 min stale
      },
    });
    testJobIds.push(job.id);

    await recovery.reconcileNow();

    // Re-enqueued
    const queued = await queue.getJob(job.id);
    expect(queued).toBeDefined();
    // Status reset to PENDING
    const dbJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect(dbJob!.status).toBe('PENDING');
  }, 30000);
});
