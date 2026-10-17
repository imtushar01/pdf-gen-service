/**
 * batch-response.dto.ts
 *
 * Public shape for batch status responses.
 * Includes per-item status so clients can show granular progress and see
 * exactly which documents failed.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchItemStatusDto {
  @ApiProperty({ example: 0, description: 'Position in the original request' })
  sequenceNumber!: number;

  @ApiProperty({ example: 'COMPLETED' })
  status!: string;

  @ApiProperty({ example: 'INVOICE' })
  documentType!: string;

  @ApiPropertyOptional({ description: 'Error message if this item failed' })
  error?: string | null;
}

export class BatchResponseDto {
  @ApiProperty({ example: 'b1a2c3...' })
  id!: string;

  @ApiProperty({
    example: 'PROCESSING',
    enum: ['PENDING', 'PROCESSING', 'FINALIZING', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED'],
  })
  status!: string;

  @ApiProperty({ example: 100, description: 'Total documents in the batch' })
  totalCount!: number;

  @ApiProperty({ example: 87, description: 'Documents completed so far' })
  completedCount!: number;

  @ApiProperty({ example: 2, description: 'Documents that failed terminally' })
  failedCount!: number;

  @ApiPropertyOptional({ description: 'Summary of failures, if any' })
  errorSummary?: string | null;

  @ApiProperty({ example: '2026-10-17T08:00:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({ example: '2026-10-17T08:03:00.000Z' })
  completedAt?: string | null;

  @ApiProperty({
    description: 'Whether the ZIP artifact is ready for download',
    example: true,
  })
  zipReady!: boolean;

  @ApiProperty({ type: [BatchItemStatusDto] })
  items!: BatchItemStatusDto[];

  static fromModel(batch: {
    id: string;
    status: string;
    totalCount: number;
    completedCount: number;
    failedCount: number;
    errorSummary?: string | null;
    createdAt: Date;
    completedAt?: Date | null;
    zipArtifact?: unknown;
    items: Array<{
      sequenceNumber: number;
      job: { status: string; documentType: string; errorMessage: string | null };
    }>;
  }): BatchResponseDto {
    return {
      id: batch.id,
      status: batch.status,
      totalCount: batch.totalCount,
      completedCount: batch.completedCount,
      failedCount: batch.failedCount,
      errorSummary: batch.errorSummary,
      createdAt: batch.createdAt.toISOString(),
      completedAt: batch.completedAt ? batch.completedAt.toISOString() : null,
      zipReady: Boolean(batch.zipArtifact),
      items: batch.items.map((item) => ({
        sequenceNumber: item.sequenceNumber,
        status: item.job.status,
        documentType: item.job.documentType,
        error: item.job.errorMessage,
      })),
    };
  }
}
