/**
 * job-response.dto.ts
 *
 * The shape of job data returned by the API.
 *
 * Why a response DTO instead of returning the Prisma model directly?
 * 1. The Prisma model has internal fields (payloadHash, maxRetries) that
 *    the client doesn't need and shouldn't see.
 * 2. We never expose internal storage paths or other implementation details.
 * 3. A stable response contract means we can change the database schema
 *    without breaking API clients.
 *
 * SOLID — Interface Segregation: the client gets exactly the fields it
 * needs, nothing more.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Job } from '@prisma/client';

export class JobResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...', description: 'Unique job identifier' })
  id!: string;

  @ApiProperty({ example: 'INVOICE', enum: ['INVOICE', 'PURCHASE_ORDER'] })
  documentType!: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
    description: 'Current job status',
  })
  status!: string;

  @ApiPropertyOptional({
    example: 'erp-2026-10-17-inv-001',
    description: 'The idempotency key supplied by the caller',
  })
  idempotencyKey?: string;

  @ApiProperty({ example: 0, description: 'Number of render attempts made' })
  retryCount!: number;

  @ApiPropertyOptional({ description: 'Error message if the job failed' })
  errorMessage?: string | null;

  @ApiProperty({ example: '2026-10-17T08:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-10-17T08:00:03.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ example: '2026-10-17T08:00:03.000Z' })
  completedAt?: string | null;

  /**
   * Map a Prisma Job model to the public response shape.
   * Internal fields (payloadHash, maxRetries) are deliberately excluded.
   */
  static fromModel(job: Job): JobResponseDto {
    return {
      id: job.id,
      documentType: job.documentType,
      status: job.status,
      idempotencyKey: job.idempotencyKey,
      retryCount: job.retryCount,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    };
  }
}
