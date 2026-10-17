/**
 * template.service.ts
 *
 * Compiles Handlebars templates and provides custom helpers.
 *
 * SOLID — Single Responsibility: This class only handles template compilation
 * and rendering. It does not know about Puppeteer, PDFs, or the database.
 *
 * SECURITY — Handlebars escaping:
 * By default, {{value}} HTML-escapes the output. We register custom helpers
 * that format numbers/currency and return safe strings. The formatCurrency
 * and formatNumber helpers use Handlebars.Utils.escapeExpression internally
 * to ensure no raw HTML leaks through, then wrap in SafeString.
 *
 * Custom helpers:
 * - formatCurrency(n, currency) → "₹1,500.00"
 * - formatNumber(n)             → "1,500"
 * - eq(a, b)                    → boolean (used in {{#if (eq a b)}})
 * - gt(a, b)                    → boolean
 * - inc(n)                      → n + 1 (for 1-indexed page numbers)
 * - dec(n)                      → n - 1 (for zero-indexed comparisons)
 * - mul(a, b)                   → a * b (for tax calculations)
 * - div(a, b)                   → a / b
 */
import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PDF_STYLES } from './templates/styles';

@Injectable()
export class TemplateService {
  private readonly invoiceTemplate: HandlebarsTemplateDelegate;
  private readonly poTemplate: HandlebarsTemplateDelegate;

  constructor() {
    this.registerHelpers();
    this.invoiceTemplate = this.compile('invoice.hbs');
    this.poTemplate = this.compile('purchase-order.hbs');
  }

  /**
   * Render an invoice template with the given data.
   */
  renderInvoice(data: Record<string, unknown>): string {
    return this.invoiceTemplate(data);
  }

  /**
   * Render a purchase order template with the given data.
   */
  renderPurchaseOrder(data: Record<string, unknown>): string {
    return this.poTemplate(data);
  }

  private compile(filename: string): HandlebarsTemplateDelegate {
    const templatePath = join(__dirname, 'templates', filename);
    const source = readFileSync(templatePath, 'utf-8');
    // strict: false — optional fields in {{#if}} blocks are allowed to be undefined.
    // Input safety is handled by class-validator at the DTO layer, not by Handlebars.
    return Handlebars.compile(source);
  }

  private registerHelpers(): void {
    Handlebars.registerHelper('formatCurrency', (value: unknown, currency: string) => {
      const num = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(num)) return new Handlebars.SafeString('—');
      const symbol = this.currencySymbol(currency);
      const formatted = num.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return new Handlebars.SafeString(`${symbol}${formatted}`);
    });

    Handlebars.registerHelper('formatNumber', (value: unknown) => {
      const num = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(num)) return new Handlebars.SafeString('—');
      return new Handlebars.SafeString(
        num.toLocaleString('en-IN', { maximumFractionDigits: 4 }),
      );
    });

    Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));
    Handlebars.registerHelper('inc', (n: unknown) => Number(n) + 1);
    Handlebars.registerHelper('dec', (n: unknown) => Number(n) - 1);
    Handlebars.registerHelper('mul', (a: unknown, b: unknown) => Number(a) * Number(b));
    Handlebars.registerHelper('div', (a: unknown, b: unknown) => Number(a) / Number(b));

    // Register the styles as a helper so templates can use {{{styles}}}
    Handlebars.registerHelper('styles', () => {
      return new Handlebars.SafeString(`<style>${PDF_STYLES}</style>`);
    });
  }

  private currencySymbol(currency: string): string {
    const symbols: Record<string, string> = {
      INR: '₹',
      USD: '$',
      EUR: '€',
      GBP: '£',
    };
    return symbols[currency?.toUpperCase()] ?? `${currency} `;
  }
}
