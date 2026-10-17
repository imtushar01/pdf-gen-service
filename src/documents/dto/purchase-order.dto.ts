/**
 * purchase-order.dto.ts
 *
 * DTO for purchase order document data.
 * Same nested validation pattern as InvoiceDto — @ValidateNested + @Type.
 *
 * A PO differs from an invoice in who initiates it: the buyer issues a PO
 * to the vendor. An invoice is issued by the seller to the buyer.
 * The field names reflect this: buyerName/vendorName instead of seller/buyer.
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

export class PurchaseOrderDto {
  @ApiProperty({ example: 'PO-2026-001', description: 'Purchase order number' })
  @IsString()
  @IsNotEmpty()
  poNumber!: string;

  @ApiProperty({ example: '2026-10-17', description: 'PO date (ISO 8601)' })
  @IsDateString()
  poDate!: string;

  // ── Buyer (the one issuing the PO) ───────────────────────────────────────
  @ApiProperty({ example: 'TechStart Solutions', description: 'Buyer name' })
  @IsString()
  @IsNotEmpty()
  buyerName!: string;

  @ApiProperty({ example: '456 Tech Park, Hyderabad, 500032', description: 'Buyer address' })
  @IsString()
  @IsNotEmpty()
  buyerAddress!: string;

  // ── Vendor (the one receiving the PO) ────────────────────────────────────
  @ApiProperty({ example: 'Acme Corp Pvt Ltd', description: 'Vendor name' })
  @IsString()
  @IsNotEmpty()
  vendorName!: string;

  @ApiProperty({ example: '123 Industrial Area, Bangalore, 560001', description: 'Vendor address' })
  @IsString()
  @IsNotEmpty()
  vendorAddress!: string;

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
  @ApiProperty({ example: 88500.0, description: 'Total PO amount (incl. tax)' })
  @IsNumber()
  @Min(0)
  totalAmount!: number;

  @ApiPropertyOptional({ example: 'Deliver within 2 weeks', description: 'Notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
