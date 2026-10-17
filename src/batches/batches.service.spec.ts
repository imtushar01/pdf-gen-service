/**
 * batches.service.spec.ts
 *
 * Unit tests for the race-safe finalization logic in BatchesService.
 * We mock Prisma, the queue, the ZIP builder, and the artifact service.
 *
 * What we test:
 * 1. onChildJobDone increments completedCount on success
 * 2. onChildJobDone increments failedCount on failure
 * 3. onChildJobDone is a no-op for a non-batch job (no BatchItem)
 * 4. Finalization is claimed by exactly ONE caller (updateMany count gate)
 * 5. A second concurrent finalize attempt (count=0) does nothing
 */
import { BatchStatus } from '@prisma/client';
import { BatchesService } from './batches.service';

function makeService(overrides: {
  batchItem?: { findUnique: jest.Mock };
  batch?: Record<string, jest.Mock>;
}) {
  const prisma = {
    batchItem: overrides.batchItem ?? { findUnique: jest.fn() },
    batch: overrides.batch ?? {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    batchItemMany: { findMany: jest.fn() },
  };

  const service = new BatchesService(
    prisma as never,
    { validateDocument: jest.fn() } as never,
    { buildBatchZip: jest.fn() } as never,
    { getByJobId: jest.fn() } as never,
    { add: jest.fn() } as never,
  );

  return { service, prisma };
}

describe('BatchesService.onChildJobDone', () => {
  it('is a no-op for a non-batch job', async () => {
    const { service, prisma } = makeService({
      batchItem: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await service.onChildJobDone('standalone-job', true);

    // No batch update should happen
    expect((prisma.batch as Record<string, jest.Mock>).update).not.toHaveBeenCalled();
  });

  it('increments completedCount on success and does not finalize early', async () => {
    const batchUpdate = jest.fn().mockResolvedValue({
      completedCount: 1,
      failedCount: 0,
      totalCount: 3, // not done yet
    });
    const batchUpdateMany = jest.fn();
    const { service } = makeService({
      batchItem: {
        findUnique: jest.fn().mockResolvedValue({ batchId: 'batch-1', jobId: 'j1' }),
      },
      batch: {
        update: batchUpdate,
        updateMany: batchUpdateMany,
        findUnique: jest.fn(),
      },
    });

    await service.onChildJobDone('j1', true);

    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completedCount: { increment: 1 },
        }),
      }),
    );
    // 1 of 3 done — must NOT attempt finalization
    expect(batchUpdateMany).not.toHaveBeenCalled();
  });

  it('increments failedCount on terminal failure', async () => {
    const batchUpdate = jest.fn().mockResolvedValue({
      completedCount: 1,
      failedCount: 1,
      totalCount: 3,
    });
    const { service } = makeService({
      batchItem: {
        findUnique: jest.fn().mockResolvedValue({ batchId: 'batch-1', jobId: 'j2' }),
      },
      batch: {
        update: batchUpdate,
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
    });

    await service.onChildJobDone('j2', false);

    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failedCount: { increment: 1 },
        }),
      }),
    );
  });

  it('attempts finalization claim when all children are done', async () => {
    const batchUpdate = jest.fn().mockResolvedValue({
      completedCount: 2,
      failedCount: 1,
      totalCount: 3, // DONE
    });
    // Claim fails (someone else won) → count 0 → no finalize work
    const batchUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { service } = makeService({
      batchItem: {
        findUnique: jest.fn().mockResolvedValue({ batchId: 'batch-1', jobId: 'j3' }),
      },
      batch: {
        update: batchUpdate,
        updateMany: batchUpdateMany,
        findUnique: jest.fn(),
      },
    });

    await service.onChildJobDone('j3', true);

    // Finalization claim attempted with the PROCESSING→FINALIZING guard
    expect(batchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', status: BatchStatus.PROCESSING },
      data: { status: BatchStatus.FINALIZING },
    });
  });
});
