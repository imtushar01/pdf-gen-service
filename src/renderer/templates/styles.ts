/**
 * styles.ts
 *
 * Shared CSS for all PDF templates.
 *
 * Why a .ts file and not a .css file?
 * We inject the CSS into the Handlebars template via {{{styles}}}.
 * Keeping it as a TS string lets us use template literals for readability
 * and avoids needing a separate file loader in the build pipeline.
 *
 * Print-specific CSS:
 * - @page sets PDF page size and margins
 * - page-break-inside: avoid keeps table rows from splitting across pages
 * - -webkit-print-color-adjust: exact forces background colors to render
 *   (Puppeteer uses Chromium's print engine, which strips colors by default)
 */
export const PDF_STYLES = `
  @page {
    size: A4;
    margin: 15mm 12mm;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 11px;
    color: #1a1a1a;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .document {
    max-width: 100%;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 30px;
    padding-bottom: 15px;
    border-bottom: 2px solid #2563eb;
  }

  .header-left h1 {
    font-size: 22px;
    color: #2563eb;
    letter-spacing: 1px;
    margin-bottom: 4px;
  }

  .doc-number {
    font-size: 13px;
    color: #666;
    font-weight: 600;
  }

  .header-right {
    text-align: right;
    font-size: 11px;
  }

  .meta-row {
    margin-bottom: 3px;
  }

  .label {
    font-weight: 600;
    color: #555;
  }

  .parties {
    display: flex;
    justify-content: space-between;
    margin-bottom: 25px;
    gap: 20px;
  }

  .party {
    flex: 1;
    padding: 12px;
    background-color: #f8fafc;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
  }

  .party-label {
    font-size: 9px;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 4px;
    letter-spacing: 0.5px;
  }

  .party-name {
    font-size: 12px;
    font-weight: 700;
    margin-bottom: 2px;
  }

  .party-address {
    font-size: 10px;
    color: #475569;
    white-space: pre-line;
  }

  .party-gstin {
    font-size: 10px;
    color: #64748b;
    margin-top: 4px;
  }

  .line-items {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }

  .line-items thead th {
    background-color: #2563eb;
    color: white;
    padding: 8px 6px;
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .line-items tbody td {
    padding: 6px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 10px;
  }

  .line-items tbody tr:nth-child(even) {
    background-color: #f8fafc;
  }

  /* Prevent table rows from splitting across pages */
  .line-items tr {
    page-break-inside: avoid;
  }

  .col-num { width: 30px; text-align: center; }
  .col-desc { min-width: 200px; }
  .col-hsn { width: 70px; }
  .col-qty { width: 50px; text-align: right; }
  .col-price { width: 80px; text-align: right; }
  .col-amount { width: 90px; text-align: right; }

  .totals {
    margin-left: auto;
    width: 250px;
    margin-bottom: 20px;
  }

  .total-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 11px;
  }

  .total-final {
    border-top: 2px solid #1a1a1a;
    padding-top: 8px;
    margin-top: 4px;
    font-weight: 700;
    font-size: 13px;
  }

  .total-label {
    color: #475569;
  }

  .notes {
    margin-top: 20px;
    padding: 10px;
    background-color: #f8fafc;
    border-radius: 4px;
    font-size: 10px;
    color: #475569;
  }

  .notes-label {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .page-footer {
    text-align: center;
    font-size: 9px;
    color: #94a3b8;
    margin-top: 20px;
  }
`;
