/**
 * document-validation.service.spec.ts
 *
 * Tests the validation service's ability to:
 * 1. Accept a valid invoice
 * 2. Accept a valid purchase order
 * 3. Reject invalid nested line items (the "object-level check is insufficient" test)
 * 4. Reject when totalAmount doesn't match computed total
 * 5. Reject when a line item's amount doesn't match quantity × unitPrice
 * 6. Accept a 500-line-item document (boundary test)
 */
import { BadRequestException } from '@nestjs/common';
import { DocumentValidationService } from './document-validation.service';
import { DocumentType } from './dto/create-job.dto';

describe('DocumentValidationService', () => {
  let service: DocumentValidationService;

  beforeEach(() => {
    service = new DocumentValidationService();
  });

  const validInvoice = {
    invoiceNumber: 'INV-2026-001',
    invoiceDate: '2026-10-17',
    dueDate: '2026-11-16',
    sellerName: 'Acme Corp',
    sellerAddress: '123 Industrial Area, Bangalore',
    sellerGstin: '29ABCDE12345F1Z5',
    buyerName: 'TechStart Solutions',
    buyerAddress: '456 Tech Park, Hyderabad',
    buyerGstin: '36XYZAB67890F1Z2',
    currency: 'INR',
    lineItems: [
      { description: 'Server hosting', quantity: 5, unitPrice: 1500, amount: 7500, hsnCode: '9983' },
      { description: 'SSL certificate', quantity: 1, unitPrice: 2000, amount: 2000 },
    ],
    taxRate: 18,
    totalAmount: 11210, // 9500 + 18% = 11210
  };

  const validPo = {
    poNumber: 'PO-2026-001',
    poDate: '2026-10-17',
    buyerName: 'TechStart Solutions',
    buyerAddress: '456 Tech Park, Hyderabad',
    vendorName: 'Acme Corp',
    vendorAddress: '123 Industrial Area, Bangalore',
    currency: 'INR',
    lineItems: [
      { description: 'Laptop', quantity: 10, unitPrice: 50000, amount: 500000 },
    ],
    totalAmount: 500000,
  };

  it('should accept a valid invoice', async () => {
    const result = await service.validateDocument(
      DocumentType.INVOICE,
      validInvoice,
    );
    expect(result.type).toBe(DocumentType.INVOICE);
    expect(result.computedSubtotal).toBe(9500);
    expect(result.computedTotal).toBe(11210);
  });

  it('should accept a valid purchase order', async () => {
    const result = await service.validateDocument(
      DocumentType.PURCHASE_ORDER,
      validPo,
    );
    expect(result.type).toBe(DocumentType.PURCHASE_ORDER);
    expect(result.computedSubtotal).toBe(500000);
    expect(result.computedTotal).toBe(500000);
  });

  it('should reject an invoice with invalid nested line item (quantity as string)', async () => {
    const invalid = {
      ...validInvoice,
      lineItems: [
        { description: 'Bad item', quantity: 'banana', unitPrice: 100, amount: 100 },
      ],
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, invalid),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject an invoice with negative quantity', async () => {
    const invalid = {
      ...validInvoice,
      lineItems: [
        { description: 'Negative qty', quantity: -5, unitPrice: 100, amount: -500 },
      ],
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, invalid),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject when totalAmount does not match computed total', async () => {
    const invalid = {
      ...validInvoice,
      totalAmount: 99999, // Wrong — should be 11210
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, invalid),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject when line item amount does not match quantity × unitPrice', async () => {
    const invalid = {
      ...validInvoice,
      lineItems: [
        { description: 'Mismatch', quantity: 5, unitPrice: 100, amount: 999 },
      ],
      totalAmount: 999 + (999 * 0.18), // Fix total to match wrong amount
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, invalid),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject an invoice with missing required fields', async () => {
    const invalid = {
      invoiceNumber: 'INV-001',
      // Missing invoiceDate, sellerName, etc.
      lineItems: [{ description: 'Test', quantity: 1, unitPrice: 100, amount: 100 }],
      totalAmount: 100,
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, invalid),
    ).rejects.toThrow(BadRequestException);
  });

  it('should accept an invoice with 500 line items', async () => {
    const lineItems = Array.from({ length: 500 }, (_, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unitPrice: 100,
      amount: 100,
    }));
    const largeInvoice = {
      ...validInvoice,
      lineItems,
      totalAmount: 50000, // 500 × 100 = 50000, no tax
      taxRate: 0,
    };
    const result = await service.validateDocument(
      DocumentType.INVOICE,
      largeInvoice,
    );
    expect(result.computedSubtotal).toBe(50000);
  });

  it('should reject an invoice with more than 500 line items', async () => {
    const lineItems = Array.from({ length: 501 }, (_, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unitPrice: 100,
      amount: 100,
    }));
    const tooLarge = {
      ...validInvoice,
      lineItems,
      totalAmount: 50100,
      taxRate: 0,
    };
    await expect(
      service.validateDocument(DocumentType.INVOICE, tooLarge),
    ).rejects.toThrow(BadRequestException);
  });

  it('should handle tax rate of 0', async () => {
    const noTax = {
      ...validInvoice,
      taxRate: 0,
      totalAmount: 9500, // subtotal only
    };
    const result = await service.validateDocument(
      DocumentType.INVOICE,
      noTax,
    );
    expect(result.computedTotal).toBe(9500);
  });

  it('should handle missing tax rate (defaults to 0)', async () => {
    const noTaxField = {
      ...validInvoice,
      totalAmount: 9500,
    };
    delete (noTaxField as Record<string, unknown>).taxRate;
    const result = await service.validateDocument(
      DocumentType.INVOICE,
      noTaxField,
    );
    expect(result.computedTotal).toBe(9500);
  });
});
