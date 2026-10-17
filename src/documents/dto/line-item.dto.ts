/**
 * line-item.dto.ts
 *
 * A single line within an invoice or purchase order.
 * This is the most deeply nested DTO — it's where the assessment's
 * "object-level DTO check is insufficient" warning applies.
 *
 * Validation rules:
 * - description: required, non-empty string (prevents blank line items)
 * - quantity: required, positive number (0 or negative makes no sense)
 * - unitPrice: required, non-negative number (free is allowed, negative isn't)
 * - amount: required, must equal quantity × unitPrice (validated in service)
 * - hsnCode: optional (Harmonized System Nomenclature — used in GST invoices)
 */
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LineItemDto {
  @ApiProperty({ example: 'Server hosting (monthly)', description: 'Item description' })
  @IsString()
  @IsNotEmpty()
  description!: string;

  @ApiProperty({ example: 5, description: 'Quantity — must be positive' })
  @IsNumber()
  @Min(0.01)
  @Max(1000000)
  quantity!: number;

  @ApiProperty({ example: 1500.0, description: 'Unit price — must be non-negative' })
  @IsNumber()
  @Min(0)
  @Max(100000000)
  unitPrice!: number;

  @ApiProperty({ example: 7500.0, description: 'Total amount = quantity × unitPrice' })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ example: '9983.12', description: 'HSN/SAC code for GST' })
  @IsOptional()
  @IsString()
  hsnCode?: string;
}
