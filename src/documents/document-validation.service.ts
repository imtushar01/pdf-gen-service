/**
 * document-validation.service.ts
 *
 * Validates document data against the correct DTO based on documentType.
 *
 * Why a separate service instead of validating in the controller?
 * SOLID — Single Responsibility: the controller handles HTTP concerns
 * (parsing, routing). Validation logic is complex enough to warrant
 * its own class, and it needs to be testable in isolation.
 *
 * Why not use class-validator's polymorphic validation?
 * class-validator doesn't natively support discriminated unions
 * (validating against InvoiceDto if type=INVOICE, PurchaseOrderDto if
 * type=PURCHASE_ORDER). We do it manually: instantiate the correct DTO
 * class, run plainToClass + validate, and collect errors.
 *
 * Why validate totals?
 * The assessment says we must "decide whether totals are derived by the
 * service or validated against supplied values." We do BOTH:
 * 1. We compute the expected subtotal from line items.
 * 2. If the caller supplied a totalAmount, we verify it matches.
 * 3. If they disagree, we return a 400 with the computed value.
 * This prevents both accidental rounding bugs and intentional manipulation.
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { InvoiceDto } from './dto/invoice.dto';
import { PurchaseOrderDto } from './dto/purchase-order.dto';
import { DocumentType } from './dto/create-job.dto';

export interface ValidatedDocument {
  type: DocumentType;
  data: InvoiceDto | PurchaseOrderDto;
  computedSubtotal: number;
  computedTotal: number;
}

@Injectable()
export class DocumentValidationService {
  async validateDocument(
    type: DocumentType,
    data: Record<string, unknown>,
  ): Promise<ValidatedDocument> {
    const dto = this.instantiateDto(type, data);
    await this.runValidation(type, dto);
    return this.computeAndVerifyTotals(type, dto);
  }

  private instantiateDto(
    type: DocumentType,
    data: Record<string, unknown>,
  ): InvoiceDto | PurchaseOrderDto {
    if (type === DocumentType.INVOICE) {
      return plainToInstance(InvoiceDto, data, {
        enableImplicitConversion: true,
      });
    }
    return plainToInstance(PurchaseOrderDto, data, {
      enableImplicitConversion: true,
    });
  }

  private async runValidation(
    type: DocumentType,
    dto: InvoiceDto | PurchaseOrderDto,
  ): Promise<void> {
    const errors = await validate(dto, { whitelist: true });

    if (errors.length > 0) {
      const messages = this.flattenErrors(errors);
      throw new BadRequestException({
        message: `Validation failed for ${type}`,
        details: messages,
      });
    }
  }

  private computeAndVerifyTotals(
    type: DocumentType,
    dto: InvoiceDto | PurchaseOrderDto,
  ): ValidatedDocument {
    const lineItems = dto.lineItems;

    // Compute subtotal from line items
    const computedSubtotal = lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0,
    );

    // Verify each line item's amount matches quantity × unitPrice
    for (let i = 0; i < lineItems.length; i++) {
      const expected = lineItems[i].quantity * lineItems[i].unitPrice;
      const actual = lineItems[i].amount;
      // Allow 2 decimal places of rounding tolerance
      if (Math.abs(expected - actual) > 0.01) {
        throw new BadRequestException({
          message: `Line item ${i + 1}: amount (${actual}) does not match quantity × unitPrice (${expected})`,
        });
      }
    }

    // Compute total = subtotal + tax
    const taxRate = dto.taxRate ?? 0;
    const computedTax = (computedSubtotal * taxRate) / 100;
    const computedTotal = computedSubtotal + computedTax;

    // Verify caller's total matches our computed total
    const tolerance = 0.01; // 1 paisa tolerance for floating point
    if (Math.abs(computedTotal - dto.totalAmount) > tolerance) {
      throw new BadRequestException({
        message: `totalAmount (${dto.totalAmount}) does not match computed total (${computedTotal.toFixed(2)}). Subtotal: ${computedSubtotal.toFixed(2)}, Tax (${taxRate}%): ${computedTax.toFixed(2)}`,
      });
    }

    return {
      type,
      data: dto,
      computedSubtotal: Math.round(computedSubtotal * 100) / 100,
      computedTotal: Math.round(computedTotal * 100) / 100,
    };
  }

  private flattenErrors(errors: ValidationError[], parentPath = ''): string[] {
    const messages: string[] = [];

    for (const error of errors) {
      const path = parentPath
        ? `${parentPath}.${error.property}`
        : error.property;

      if (error.constraints) {
        for (const [key, msg] of Object.entries(error.constraints)) {
          messages.push(`${path}: ${msg} (${key})`);
        }
      }

      if (error.children && error.children.length > 0) {
        messages.push(...this.flattenErrors(error.children, path));
      }
    }

    return messages;
  }
}
