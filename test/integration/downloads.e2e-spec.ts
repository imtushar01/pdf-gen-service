/**
 * downloads.e2e-spec.ts
 *
 * End-to-end tests for the download endpoints with HTTP Range support.
 *
 * Since the async worker isn't built until M7, we set up a completed
 * artifact manually: render a real PDF, save it via ArtifactService,
 * then exercise the download endpoints over HTTP.
 *
 * What we test:
 * 1. Full download → 200, Accept-Ranges: bytes, correct Content-Length
 * 2. Range request → 206 Partial Content, correct Content-Range
 * 3. Suffix range → 206, last N bytes
 * 4. Unsatisfiable range → 416
 * 5. Malformed range → 200 (ignored, full file)
 * 6. Downloaded bytes reassemble to the full file (resume simulation)
 * 7. Checksum endpoint → verified: true
 * 8. Download for a job with no artifact → 404
 * 9. Repeated downloads return identical bytes (no regeneration)
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ArtifactService } from '../../src/artifacts/artifact.service';
import { RendererService } from '../../src/renderer/renderer.service';
import { DocumentValidationService } from '../../src/documents/document-validation.service';
import { DocumentType } from '../../src/documents/dto/create-job.dto';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { createHash } from 'crypto';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key-for-downloads-e2e-01';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://pdfuser:pdfpass@localhost:5434/pdfdb';

const API_KEY = process.env.API_KEY;

describe('Downloads API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobId: string;
  let pdfSize: number;
  let pdfSha: string;
  const testJobIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());

    prisma = app.get(PrismaService);
    const artifactService = app.get(ArtifactService);
    const renderer = app.get(RendererService);
    const validation = app.get(DocumentValidationService);

    await app.init();

    // Set up a completed job with a real PDF artifact
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: `test-download-setup-${Date.now()}`,
        payloadHash: 'setup-hash',
        status: 'COMPLETED',
      },
    });
    jobId = job.id;
    testJobIds.push(jobId);

    const validated = await validation.validateDocument(DocumentType.INVOICE, {
      invoiceNumber: 'INV-DL-001',
      invoiceDate: '2026-10-17',
      sellerName: 'Acme',
      sellerAddress: 'Addr',
      buyerName: 'Buyer',
      buyerAddress: 'Addr2',
      currency: 'INR',
      lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100, amount: 100 }],
      taxRate: 0,
      totalAmount: 100,
    });
    const { pdfBuffer } = await renderer.render(validated);
    const artifact = await artifactService.saveJobArtifact(jobId, pdfBuffer);
    pdfSize = artifact.sizeBytes;
    pdfSha = artifact.sha256;
  }, 60000);

  afterAll(async () => {
    for (const id of testJobIds) {
      await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  it('full download → 200 with Accept-Ranges and correct size', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(Number(res.headers['content-length'])).toBe(pdfSize);
    expect(res.headers['x-checksum-sha256']).toBe(pdfSha);
    // Body should be a valid PDF
    expect(res.body.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('range request → 206 Partial Content with Content-Range', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', 'bytes=0-99')
      .expect(206);

    expect(res.headers['content-range']).toBe(`bytes 0-99/${pdfSize}`);
    expect(Number(res.headers['content-length'])).toBe(100);
    expect(res.body.length).toBe(100);
  });

  it('suffix range → 206 with last N bytes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', 'bytes=-50')
      .expect(206);

    expect(Number(res.headers['content-length'])).toBe(50);
    const expectedStart = pdfSize - 50;
    expect(res.headers['content-range']).toBe(
      `bytes ${expectedStart}-${pdfSize - 1}/${pdfSize}`,
    );
  });

  it('unsatisfiable range → 416', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', `bytes=${pdfSize + 100}-`)
      .expect(416);

    expect(res.headers['content-range']).toBe(`bytes */${pdfSize}`);
  });

  it('malformed range → 200 full file (ignored)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', 'bytes=garbage')
      .expect(200);

    expect(Number(res.headers['content-length'])).toBe(pdfSize);
  });

  it('resume simulation: two ranges reassemble to the full file', async () => {
    const half = Math.floor(pdfSize / 2);

    const part1 = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', `bytes=0-${half - 1}`)
      .expect(206);

    const part2 = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .set('Range', `bytes=${half}-`)
      .expect(206);

    const reassembled = Buffer.concat([
      part1.body as Buffer,
      part2.body as Buffer,
    ]);
    expect(reassembled.length).toBe(pdfSize);

    // The reassembled checksum must match the stored checksum
    const reassembledSha = createHash('sha256')
      .update(reassembled)
      .digest('hex');
    expect(reassembledSha).toBe(pdfSha);
  });

  it('checksum endpoint → verified true', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/checksum`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.body.sha256).toBe(pdfSha);
    expect(res.body.sizeBytes).toBe(pdfSize);
    expect(res.body.verified).toBe(true);
  });

  it('download for a job with no artifact → 404', async () => {
    const job = await prisma.job.create({
      data: {
        documentType: 'INVOICE',
        idempotencyKey: `test-download-noartifact-${Date.now()}`,
        payloadHash: 'h',
      },
    });
    testJobIds.push(job.id);

    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${job.id}/download`)
      .set('X-API-Key', API_KEY)
      .expect(404);
  });

  it('repeated downloads return identical bytes (no regeneration)', async () => {
    const first = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    const second = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}/download`)
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect((first.body as Buffer).equals(second.body as Buffer)).toBe(true);
  });
});
