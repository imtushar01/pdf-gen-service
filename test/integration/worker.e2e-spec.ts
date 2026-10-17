/**
 * worker.e2e-spec.ts
 *
 * TRUE end-to-end test of the async pipeline:
 *   create job (producer) → BullMQ → worker renders → COMPLETED → artifact.
 *
 * We start BOTH the API module (to create jobs) and the worker processor
 * (to consume them) in the same test process, sharing the real Redis and
 * PostgreSQL from docker-compose.
 *
 * What we test:
 * 1. A created job transitions PENDING → COMPLETED and gets an artifact.
 * 2. The artifact checksum verifies.
 * 3. Duplicate processing is safe (re-adding the same job ID is a no-op).
 *
 * Prerequisites: docker compose up -d (Postgres + Redis running).
 *
 * NOTE: This test uses real timers and polls the DB for completion. It has
 * generous timeouts because it launches a real Chromium browser.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from '../../src/config/configuration';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueueModule } from '../../src/queue/queue.module';
import { StorageModule } from '../../src/storage/storage.module';
import { RendererModule } from '../../src/renderer/renderer.module';
import { ArtifactsModule } from '../../src/artifacts/artifacts.module';
import { DocumentsModule } from '../../src/documents/documents.module';
import { JobsModule } from '../../src/jobs/jobs.module';
import { ArtifactService } from '../../src/artifacts/artifact.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { PdfProcessor } from '../../src/queue/pdf.processor';
import { DocumentType } from '../../src/documents/dto/create-job.dto';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key-for-worker-e2e-0001';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://pdfuser:pdfpass@localhost:5434/pdfdb';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6380';

async function waitForStatus(
  prisma: PrismaService,
  jobId: string,
  target: string,
  timeoutMs = 30000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job && job.status === target) return job.status;
    if (job && (job.status === 'FAILED' || job.status === 'COMPLETED')) {
      return job.status; // terminal — stop waiting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${target}`);
}

describe('Worker async pipeline (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobsService: JobsService;
  let artifactService: ArtifactService;
  const testKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        PrismaModule,
        QueueModule,
        StorageModule,
        RendererModule,
        ArtifactsModule,
        DocumentsModule,
        JobsModule,
      ],
      providers: [PdfProcessor],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    jobsService = app.get(JobsService);
    artifactService = app.get(ArtifactService);
  }, 60000);

  afterAll(async () => {
    for (const key of testKeys) {
      await prisma.job
        .deleteMany({ where: { idempotencyKey: key } })
        .catch(() => undefined);
    }
    await app.close();
  });

  const validInvoice = {
    invoiceNumber: 'INV-WORKER-001',
    invoiceDate: '2026-10-17',
    sellerName: 'Acme',
    sellerAddress: 'Addr',
    buyerName: 'Buyer',
    buyerAddress: 'Addr2',
    currency: 'INR',
    lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100, amount: 100 }],
    taxRate: 0,
    totalAmount: 100,
  };

  it('should process a job from PENDING to COMPLETED with an artifact', async () => {
    const key = `test-worker-complete-${Date.now()}`;
    testKeys.push(key);

    const { job } = await jobsService.createJob({
      documentType: DocumentType.INVOICE,
      data: validInvoice,
      idempotencyKey: key,
    });

    expect(job.status).toBe('PENDING');

    // Wait for the worker to render and complete it
    const finalStatus = await waitForStatus(prisma, job.id, 'COMPLETED', 40000);
    expect(finalStatus).toBe('COMPLETED');

    // An artifact must exist with a valid checksum
    const artifact = await artifactService.getByJobId(job.id);
    expect(artifact).toBeDefined();
    expect(artifact!.sizeBytes).toBeGreaterThan(0);

    const verification = await artifactService.verifyChecksum(job.id);
    expect(verification.valid).toBe(true);
  }, 60000);

  it('should be idempotent: re-enqueuing a completed job does not duplicate work', async () => {
    const key = `test-worker-idem-${Date.now()}`;
    testKeys.push(key);

    const { job } = await jobsService.createJob({
      documentType: DocumentType.INVOICE,
      data: validInvoice,
      idempotencyKey: key,
    });

    await waitForStatus(prisma, job.id, 'COMPLETED', 40000);

    const artifactBefore = await artifactService.getByJobId(job.id);

    // Re-enqueue the same job ID — BullMQ dedups by jobId, and the processor
    // skips already-completed jobs. No duplicate artifact should be created.
    await jobsService.enqueueRender(job.id);
    await new Promise((r) => setTimeout(r, 2000));

    const artifactAfter = await artifactService.getByJobId(job.id);
    expect(artifactAfter!.id).toBe(artifactBefore!.id);
    expect(artifactAfter!.sha256).toBe(artifactBefore!.sha256);
  }, 60000);
});
