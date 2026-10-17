/**
 * batch-item-request.dto.ts
 *
 * A single item within a bulk generation request (POST /api/v1/batches).
 * Same shape as CreateJobDto but without the idempotencyKey — the batch
 * itself gets an idempotency key, and each item gets a sequence number.
 *
 * We give each child job a derived idempotency key:
 *   `{batchIdempotencyKey}-{sequenceNumber}`
 * so duplicates within a batch are impossible.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from './create-job.dto';

export class BatchItemRequestDto {
  @ApiProperty({ enum: DocumentType, example: 'INVOICE' })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({ type: 'object', description: 'Invoice or PO data' })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiPropertyOptional({ example: '2026-10-17' })
  @IsOptional()
  @IsDateString()
  requestDate?: string;
}

export class CreateBatchDto {
  @ApiProperty({
    type: [BatchItemRequestDto],
    description: 'Documents to generate (1–100)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BatchItemRequestDto)
  items!: BatchItemRequestDto[];

  @ApiPropertyOptional({
    example: 'erp-bulk-2026-10-17-001',
    description: 'Idempotency key for the entire batch',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  idempotencyKey?: string;
}
