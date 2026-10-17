/**
 * invoice.dto.ts
 *
 * DTO for invoice document data submitted by the ERP.
 *
 * KEY TEACHING POINT — nested validation:
 * @ValidateNested() tells class-validator to validate each object in the
 * lineItems array. @Type(() => LineItemDto) tells class-transformer to
 * convert plain JSON objects into LineItemDto instances so the decorators
 * on LineItemDto fire. Without @Type(), the items stay as plain objects
 * and @IsNumber() on quantity would never run — a string "banana" would
 * pass through silently.
 *
 * @ArrayMinSize(1) — an invoice with zero line items is meaningless.
 * @ArrayMaxSize(500) — the assessment says 500+ line items cause OOM.
 *   We cap at 500 per document and handle the rendering safety in the
 *   renderer via chunked rendering (see renderer.service.ts).
 *
 * Total validation: we accept totals from the caller but the renderer
 * service will independently compute subtotal from line items. If the
 * caller's total doesn't match our computed total, we reject the request.
 * This prevents both accidental rounding errors and intentional manipulation.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LineItemDto } from './line-item.dto';

export class InvoiceDto {
  @ApiProperty({ example: 'INV-2026-001', description: 'Invoice number' })
  @IsString()
  @IsNotEmpty()
  invoiceNumber!: string;

  @ApiProperty({ example: '2026-10-17', description: 'Invoice date (ISO 8601)' })
  @IsDateString()
  invoiceDate!: string;

  @ApiPropertyOptional({ example: '2026-11-16', description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  // ── Seller ──────────────────────────────────────────────────────────────
  @ApiProperty({ example: 'Acme Corp Pvt Ltd', description: 'Seller name' })
  @IsString()
  @IsNotEmpty()
  sellerName!: string;

  @ApiProperty({ example: '123 Industrial Area, Bangalore, 560001', description: 'Seller address' })
  @IsString()
  @IsNotEmpty()
  sellerAddress!: string;

  @ApiPropertyOptional({ example: '29ABCDE12345F1Z5', description: 'Seller GSTIN' })
  @IsOptional()
  @IsString()
  sellerGstin?: string;

  // ── Buyer ───────────────────────────────────────────────────────────────
  @ApiProperty({ example: 'TechStart Solutions', description: 'Buyer name' })
  @IsString()
  @IsNotEmpty()
  buyerName!: string;

  @ApiProperty({ example: '456 Tech Park, Hyderabad, 500032', description: 'Buyer address' })
  @IsString()
  @IsNotEmpty()
  buyerAddress!: string;

  @ApiPropertyOptional({ example: '36XYZAB67890F1Z2', description: 'Buyer GSTIN' })
  @IsOptional()
  @IsString()
  buyerGstin?: string;

  // ── Currency and amounts ────────────────────────────────────────────────
  @ApiProperty({ example: 'INR', description: 'ISO 4217 currency code' })
  @IsString()
  @IsNotEmpty()
  currency!: string;

  // ── Line items ──────────────────────────────────────────────────────────
  @ApiProperty({
    type: [LineItemDto],
    description: 'Line items (1–500). Each item is independently validated.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems!: LineItemDto[];

  // ── Tax ─────────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ example: 18, description: 'Tax rate percentage (0–100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  // ── Total ───────────────────────────────────────────────────────────────
  @ApiProperty({ example: 88500.0, description: 'Total invoice amount (incl. tax)' })
  @IsNumber()
  @Min(0)
  totalAmount!: number;

  @ApiPropertyOptional({ example: 'Payment due within 30 days', description: 'Notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
