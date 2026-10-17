/**
 * renderer.integration.spec.ts
 *
 * Integration test that actually generates a real PDF using Puppeteer.
 * Requires Chromium to be installed (puppeteer handles this).
 *
 * What we test:
 * 1. A small invoice renders to a non-empty PDF buffer
 * 2. The PDF starts with the correct magic bytes (%PDF)
 * 3. A purchase order renders correctly
 * 4. A large document (500 line items) renders via chunking without OOM
 * 5. The template escapes HTML in user-controlled fields (XSS test)
 *
 * NOTE: This test launches a real Chromium browser, so it's slower.
 * It's in the integration directory and should be run separately from
 * unit tests.
 */
import { ConfigService } from '@nestjs/config';
import { RendererService } from '../../src/renderer/renderer.service';
import { TemplateService } from '../../src/renderer/template.service';
import { DocumentValidationService } from '../../src/documents/document-validation.service';
import { DocumentType } from '../../src/documents/dto/create-job.dto';

// Test configuration
const mockConfig = {
  renderConcurrency: 2,
  renderTimeoutMs: 30000,
  renderChunkSize: 100,
};

function makeConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
  } as unknown as ConfigService;
}

describe('RendererService (integration)', () => {
  let renderer: RendererService;
  let validationService: DocumentValidationService;

  beforeAll(async () => {
    const configService = makeConfigService();
    const templateService = new TemplateService();
    renderer = new RendererService(configService, templateService);
    validationService = new DocumentValidationService();
    await renderer.onModuleInit();
  }, 60000); // Allow extra time for Chromium download

  afterAll(async () => {
    await renderer.onModuleDestroy();
  });

  const validInvoice = {
    invoiceNumber: 'INV-2026-001',
    invoiceDate: '2026-10-17',
    dueDate: '2026-11-16',
    sellerName: 'Acme Corp',
    sellerAddress: '123 Industrial Area, Bangalore',
    buyerName: 'TechStart Solutions',
    buyerAddress: '456 Tech Park, Hyderabad',
    currency: 'INR',
    lineItems: [
      { description: 'Server hosting', quantity: 5, unitPrice: 1500, amount: 7500, hsnCode: '9983' },
      { description: 'SSL certificate', quantity: 1, unitPrice: 2000, amount: 2000 },
    ],
    taxRate: 18,
    totalAmount: 11210,
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

  it('should render an invoice to a PDF buffer', async () => {
    const validated = await validationService.validateDocument(
      DocumentType.INVOICE,
      validInvoice,
    );
    const result = await renderer.render(validated);

    expect(result.pdfBuffer).toBeDefined();
    expect(result.pdfBuffer.length).toBeGreaterThan(0);
    expect(result.pageCount).toBe(1);

    // PDF magic bytes — every valid PDF starts with %PDF
    expect(result.pdfBuffer.toString('ascii', 0, 4)).toBe('%PDF');
  }, 30000);

  it('should render a purchase order to a PDF buffer', async () => {
    const validated = await validationService.validateDocument(
      DocumentType.PURCHASE_ORDER,
      validPo,
    );
    const result = await renderer.render(validated);

    expect(result.pdfBuffer).toBeDefined();
    expect(result.pdfBuffer.length).toBeGreaterThan(0);
    expect(result.pdfBuffer.toString('ascii', 0, 4)).toBe('%PDF');
  }, 30000);

  it('should render a 500-line-item invoice via chunking without OOM', async () => {
    const lineItems = Array.from({ length: 500 }, (_, i) => ({
      description: `Line item ${i + 1}`,
      quantity: 1,
      unitPrice: 100,
      amount: 100,
    }));

    const largeInvoice = {
      ...validInvoice,
      lineItems,
      taxRate: 0,
      totalAmount: 50000,
    };

    const validated = await validationService.validateDocument(
      DocumentType.INVOICE,
      largeInvoice,
    );

    const result = await renderer.render(validated);

    expect(result.pdfBuffer).toBeDefined();
    expect(result.pdfBuffer.length).toBeGreaterThan(1000); // Should be a substantial PDF
    expect(result.pdfBuffer.toString('ascii', 0, 4)).toBe('%PDF');
    expect(result.pageCount).toBe(5); // 500 items / 100 per chunk = 5 chunks
  }, 60000); // Allow extra time for chunked rendering

  it('should escape HTML in user-controlled fields', async () => {
    const xssInvoice = {
      ...validInvoice,
      sellerName: '<script>alert("xss")</script>',
      buyerName: '<img src=x onerror=alert(1)>',
      lineItems: [
        {
          description: '<b>Bold</b> <script>alert(1)</script>',
          quantity: 1,
          unitPrice: 100,
          amount: 100,
        },
      ],
      taxRate: 0,
      totalAmount: 100,
    };

    const validated = await validationService.validateDocument(
      DocumentType.INVOICE,
      xssInvoice,
    );

    const result = await renderer.render(validated);
    const pdfText = result.pdfBuffer.toString('latin1');

    // The PDF should NOT contain raw <script> tags — they should be escaped
    expect(pdfText).not.toContain('<script>');
    expect(pdfText).not.toContain('alert("xss")');
  }, 30000);
});
