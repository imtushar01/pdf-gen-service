/**
 * jobs.service.spec.ts
 *
 * Unit tests for JobsService idempotency logic.
 * We mock PrismaService and DocumentValidationService so these tests
 * run fast with no database.
 *
 * What we test (the three idempotency cases):
 * 1. New key → creates a new job
 * 2. Same key, same payload → returns existing job (isExisting: true)
 * 3. Same key, different payload → throws ConflictException
 * 4. getJob throws NotFoundException for unknown ID
 * 5. Concurrent insert (P2002) → returns existing job
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobsService } from './jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentValidationService } from '../documents/document-validation.service';
import { DocumentType } from '../documents/dto/create-job.dto';
import { fingerprintPayload } from '../common/utils/fingerprint.util';

describe('JobsService', () => {
  let service: JobsService;
  let prisma: {
    job: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    inputSnapshot: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let validation: { validateDocument: jest.Mock };
  let queue: { add: jest.Mock };

  const samplePayload = { invoiceNumber: 'INV-1', total: 100 };

  beforeEach(() => {
    prisma = {
      job: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      inputSnapshot: { findUnique: jest.fn() },
      // $transaction runs the callback with the prisma mock as tx
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    validation = {
      validateDocument: jest.fn().mockResolvedValue({}),
    };
    // Mock BullMQ queue — add() resolves to a fake job
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'bull-job' }),
    };

    service = new JobsService(
      prisma as unknown as PrismaService,
      validation as unknown as DocumentValidationService,
      queue as never,
    );
  });

  it('should create a new job for a new idempotency key', async () => {
    prisma.job.findUnique.mockResolvedValue(null); // no existing
    const createdJob = {
      id: 'job-1',
      documentType: 'INVOICE',
      status: 'PENDING',
      idempotencyKey: 'key-1',
      payloadHash: fingerprintPayload(samplePayload),
      retryCount: 0,
    };
    prisma.job.create.mockResolvedValue(createdJob);

    const result = await service.createJob({
      documentType: DocumentType.INVOICE,
      data: samplePayload,
      idempotencyKey: 'key-1',
    });

    expect(result.isExisting).toBe(false);
    expect(result.job.id).toBe('job-1');
    expect(validation.validateDocument).toHaveBeenCalled();
    expect(prisma.job.create).toHaveBeenCalled();
    // A new job must be enqueued for rendering
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('should NOT enqueue when returning an existing job', async () => {
    const existingHash = fingerprintPayload(samplePayload);
    prisma.job.findUnique.mockResolvedValue({
      id: 'existing-job',
      idempotencyKey: 'key-1',
      payloadHash: existingHash,
      status: 'COMPLETED',
    });

    await service.createJob({
      documentType: DocumentType.INVOICE,
      data: samplePayload,
      idempotencyKey: 'key-1',
    });

    // Idempotent retry must not enqueue a duplicate render
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('should return existing job for same key + same payload (Case 1)', async () => {
    const existingHash = fingerprintPayload(samplePayload);
    prisma.job.findUnique.mockResolvedValue({
      id: 'existing-job',
      idempotencyKey: 'key-1',
      payloadHash: existingHash,
      status: 'COMPLETED',
    });

    const result = await service.createJob({
      documentType: DocumentType.INVOICE,
      data: samplePayload,
      idempotencyKey: 'key-1',
    });

    expect(result.isExisting).toBe(true);
    expect(result.job.id).toBe('existing-job');
    // Should NOT create a new job
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it('should throw ConflictException for same key + different payload (Case 2)', async () => {
    prisma.job.findUnique.mockResolvedValue({
      id: 'existing-job',
      idempotencyKey: 'key-1',
      payloadHash: 'a-completely-different-hash',
      status: 'COMPLETED',
    });

    await expect(
      service.createJob({
        documentType: DocumentType.INVOICE,
        data: samplePayload,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it('should handle concurrent insert race (P2002) by returning existing job', async () => {
    const hash = fingerprintPayload(samplePayload);
    // First findUnique: no existing job (we think we're first)
    // After P2002, second findUnique: the racing job exists
    prisma.job.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'raced-job',
        idempotencyKey: 'key-1',
        payloadHash: hash,
        status: 'PENDING',
      });

    // create throws a unique constraint violation
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '5.22.0' },
    );
    prisma.job.create.mockRejectedValue(p2002);

    const result = await service.createJob({
      documentType: DocumentType.INVOICE,
      data: samplePayload,
      idempotencyKey: 'key-1',
    });

    expect(result.isExisting).toBe(true);
    expect(result.job.id).toBe('raced-job');
  });

  it('should throw NotFoundException for an unknown job ID', async () => {
    prisma.job.findUnique.mockResolvedValue(null);
    await expect(service.getJob('does-not-exist')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should return a job that exists', async () => {
    prisma.job.findUnique.mockResolvedValue({ id: 'job-x', status: 'PENDING' });
    const job = await service.getJob('job-x');
    expect(job.id).toBe('job-x');
  });

  it('should generate a unique key when none is supplied', async () => {
    prisma.job.findUnique.mockResolvedValue(null);
    prisma.job.create.mockImplementation((args: { data: { idempotencyKey: string } }) =>
      Promise.resolve({ id: 'auto-job', ...args.data }),
    );

    const result = await service.createJob({
      documentType: DocumentType.INVOICE,
      data: samplePayload,
    });

    expect(result.isExisting).toBe(false);
    // The auto-generated key should start with "auto-"
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^auto-/) as string,
        }),
      }),
    );
  });
});
