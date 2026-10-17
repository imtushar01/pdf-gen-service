/**
 * jobs.e2e-spec.ts
 *
 * End-to-end tests for the jobs API with a real PostgreSQL database.
 * Starts the full NestJS application and sends real HTTP requests.
 *
 * What we test:
 * 1. POST /api/v1/jobs without API key → 401
 * 2. POST with valid invoice → 202 Accepted, job in PENDING
 * 3. GET /api/v1/jobs/:id → returns the job
 * 4. Idempotency Case 1: same key + same payload → 200, same job ID
 * 5. Idempotency Case 2: same key + different payload → 409 Conflict
 * 6. POST with invalid data → 400
 * 7. GET unknown job → 404
 * 8. Snapshot immutability: the stored snapshot matches the submitted data
 *
 * Prerequisites: docker compose up -d
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key-for-jobs-e2e-123456';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://pdfuser:pdfpass@localhost:5434/pdfdb';

const API_KEY = process.env.API_KEY;

const validInvoice = {
  documentType: 'INVOICE',
  data: {
    invoiceNumber: 'INV-E2E-001',
    invoiceDate: '2026-10-17',
    sellerName: 'Acme Corp',
    sellerAddress: '123 Industrial Area',
    buyerName: 'TechStart',
    buyerAddress: '456 Tech Park',
    currency: 'INR',
    lineItems: [
      { description: 'Service', quantity: 2, unitPrice: 500, amount: 1000 },
    ],
    taxRate: 0,
    totalAmount: 1000,
  },
};

describe('Jobs API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());

    prisma = app.get(PrismaService);
    await app.init();
  }, 30000);

  afterAll(async () => {
    // Clean up test jobs
    for (const key of createdKeys) {
      await prisma.job
        .deleteMany({ where: { idempotencyKey: key } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('should reject POST /jobs without API key (401)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .send(validInvoice)
      .expect(401);
  });

  it('should create a job with valid invoice (202)', async () => {
    const key = 'test-e2e-create-1';
    createdKeys.push(key);

    const res = await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key })
      .expect(202);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
    expect(res.body.documentType).toBe('INVOICE');
    // Internal fields must NOT be exposed
    expect(res.body.payloadHash).toBeUndefined();
    expect(res.body.maxRetries).toBeUndefined();
  });

  it('should fetch a job by ID', async () => {
    const key = 'test-e2e-fetch-1';
    createdKeys.push(key);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key });

    const jobId = createRes.body.id;

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(getRes.body.id).toBe(jobId);
  });

  it('Idempotency Case 1: same key + same payload returns existing job (200)', async () => {
    const key = 'test-e2e-idem-1';
    createdKeys.push(key);

    const first = await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key })
      .expect(202);

    // Second identical request → 200 OK, same job
    const second = await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });

  it('Idempotency Case 2: same key + different payload returns 409', async () => {
    const key = 'test-e2e-idem-2';
    createdKeys.push(key);

    await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key })
      .expect(202);

    // Different payload, same key
    const modified = {
      ...validInvoice,
      idempotencyKey: key,
      data: { ...validInvoice.data, invoiceNumber: 'INV-CHANGED' },
    };

    await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send(modified)
      .expect(409);
  });

  it('should reject invalid data with 400', async () => {
    const key = 'test-e2e-invalid-1';
    createdKeys.push(key);

    const invalid = {
      documentType: 'INVOICE',
      idempotencyKey: key,
      data: {
        invoiceNumber: 'INV-BAD',
        // Missing required fields, bad line items
        lineItems: [{ description: 'X', quantity: 'not-a-number', unitPrice: 1, amount: 1 }],
        totalAmount: 1,
      },
    };

    await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send(invalid)
      .expect(400);
  });

  it('should return 404 for an unknown job ID', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/jobs/00000000-0000-0000-0000-000000000000')
      .set('X-API-Key', API_KEY)
      .expect(404);
  });

  it('should store an immutable snapshot matching the submitted data', async () => {
    const key = 'test-e2e-snapshot-1';
    createdKeys.push(key);

    const res = await request(app.getHttpServer())
      .post('/api/v1/jobs')
      .set('X-API-Key', API_KEY)
      .send({ ...validInvoice, idempotencyKey: key });

    const jobId = res.body.id;

    // Read the snapshot directly from the database
    const snapshot = await prisma.inputSnapshot.findUnique({
      where: { jobId },
    });

    expect(snapshot).toBeDefined();
    const data = snapshot!.data as Record<string, unknown>;
    expect(data.invoiceNumber).toBe('INV-E2E-001');
    expect(data.totalAmount).toBe(1000);
  });
});
