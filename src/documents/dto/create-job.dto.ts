/**
 * create-job.dto.ts
 *
 * Top-level DTO for a single document generation request.
 *
 * The ERP sends this to POST /api/v1/jobs.
 * The `documentType` field tells us which template to use.
 * The `data` field contains the invoice or purchase order payload.
 *
 * The `idempotencyKey` is supplied by the caller and prevents duplicate
 * job creation. If the same key is reused with the same payload, we return
 * the existing job. If the same key is reused with a DIFFERENT payload,
 * we return 409 Conflict.
 *
 * Why not use a discriminated union with `oneOf`?
 * class-validator doesn't validate discriminated unions natively.
 * Instead, we validate `data` as a plain object here and do type-specific
 * validation in the service layer using the documentType field.
 * This is a pragmatic compromise — see the service for details.
 */
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DocumentType {
  INVOICE = 'INVOICE',
  PURCHASE_ORDER = 'PURCHASE_ORDER',
}

export class CreateJobDto {
  @ApiProperty({
    enum: DocumentType,
    example: 'INVOICE',
    description: 'Document type — determines which template is used',
  })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({
    description: 'Invoice or purchase order data. Validated against the document type in the service layer.',
    type: 'object',
  })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'erp-2026-10-17-inv-001',
    description:
      'Caller-supplied idempotency key. ' +
      'Reusing the same key with the same payload returns the existing job. ' +
      'Reusing it with a different payload returns 409 Conflict.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  idempotencyKey?: string;

  @ApiPropertyOptional({
    example: '2026-10-17',
    description: 'Caller-side timestamp for audit purposes',
  })
  @IsOptional()
  @IsDateString()
  requestDate?: string;
}
