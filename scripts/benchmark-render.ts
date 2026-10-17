/**
 * benchmark-render.ts
 *
 * Measures REAL render time and memory per PDF on THIS machine.
 *
 * Run: npm run benchmark
 *
 * Why this exists:
 * The assessment forbids claiming the local machine handles production load
 * without measurement. This script produces actual numbers we record in
 * APPROACH.md — render latency (small + large docs) and peak RSS memory —
 * so our capacity math is grounded in reality, clearly separated from the
 * assessment's hypothetical inputs.
 *
 * Methodology:
 *   - Launch the real RendererService (headless Chromium).
 *   - Render a small invoice (2 line items) N times, record per-render ms.
 *   - Render a large invoice (500 line items) N times, record per-render ms.
 *   - Sample process RSS before/after to estimate memory footprint.
 *   - Report min / mean / p95 / max and derived single-slot throughput.
 *
 * Caveats (printed in the output):
 *   - Numbers are for this dev machine, not the target EC2 r6i.large.
 *   - RSS includes Node + Chromium shared memory; it is an estimate, not a
 *     precise per-render allocation.
 */
import { ConfigService } from '@nestjs/config';
import { RendererService } from '../src/renderer/renderer.service';
import { TemplateService } from '../src/renderer/template.service';
import { DocumentValidationService } from '../src/documents/document-validation.service';
import { DocumentType } from '../src/documents/dto/create-job.dto';

const SMALL_RUNS = 20;
const LARGE_RUNS = 5;

function makeConfig(): ConfigService {
  const values: Record<string, number> = {
    renderConcurrency: 1, // single slot — we measure one render at a time
    renderTimeoutMs: 60000,
    renderChunkSize: 100,
  };
  return {
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

function buildInvoice(lineItemCount: number) {
  const lineItems = Array.from({ length: lineItemCount }, (_, i) => ({
    description: `Line item ${i + 1} with a reasonably long description`,
    quantity: 1,
    unitPrice: 100,
    amount: 100,
  }));
  return {
    invoiceNumber: 'INV-BENCH',
    invoiceDate: '2026-10-17',
    sellerName: 'Benchmark Seller Pvt Ltd',
    sellerAddress: '123 Benchmark Road, Test City, 560001',
    buyerName: 'Benchmark Buyer Solutions',
    buyerAddress: '456 Sample Street, Demo Town, 500032',
    currency: 'INR',
    lineItems,
    taxRate: 18,
    totalAmount: lineItemCount * 100 * 1.18,
  };
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    min: sorted[0],
    mean: sum / sorted.length,
    p95: sorted[p95Index],
    max: sorted[sorted.length - 1],
  };
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function run(): Promise<void> {
  const renderer = new RendererService(makeConfig(), new TemplateService());
  const validation = new DocumentValidationService();
  await renderer.onModuleInit();

  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > rssPeak) rssPeak = rss;
  };

  // ── Small documents ──────────────────────────────────────────────────────
  const smallMs: number[] = [];
  const smallValidated = await validation.validateDocument(
    DocumentType.INVOICE,
    buildInvoice(2),
  );
  for (let i = 0; i < SMALL_RUNS; i++) {
    const t0 = Date.now();
    await renderer.render(smallValidated);
    smallMs.push(Date.now() - t0);
    sampleRss();
  }

  // ── Large documents (500 line items → chunked) ─────────────────────────────
  const largeMs: number[] = [];
  const largeValidated = await validation.validateDocument(
    DocumentType.INVOICE,
    buildInvoice(500),
  );
  for (let i = 0; i < LARGE_RUNS; i++) {
    const t0 = Date.now();
    await renderer.render(largeValidated);
    largeMs.push(Date.now() - t0);
    sampleRss();
  }

  await renderer.onModuleDestroy();

  const small = stats(smallMs);
  const large = stats(largeMs);

  // Single continuously-busy render slot throughput (docs/min)
  const smallThroughput = Math.round(60000 / small.mean);
  const largeThroughput = Math.round(60000 / large.mean);

  console.log('\n===== RENDER BENCHMARK (this machine) =====');
  console.log(`Platform: ${process.platform} ${process.arch}, Node ${process.version}`);
  console.log(`\nSmall invoice (2 line items), ${SMALL_RUNS} runs:`);
  console.log(
    `  min=${small.min}ms  mean=${small.mean.toFixed(0)}ms  p95=${small.p95}ms  max=${small.max}ms`,
  );
  console.log(`  single-slot throughput ≈ ${smallThroughput} PDFs/min`);
  console.log(`\nLarge invoice (500 line items, chunked), ${LARGE_RUNS} runs:`);
  console.log(
    `  min=${large.min}ms  mean=${large.mean.toFixed(0)}ms  p95=${large.p95}ms  max=${large.max}ms`,
  );
  console.log(`  single-slot throughput ≈ ${largeThroughput} PDFs/min`);
  console.log(`\nMemory (process RSS):`);
  console.log(`  start=${mb(rssStart)}MB  peak=${mb(rssPeak)}MB  delta=${mb(rssPeak - rssStart)}MB`);
  console.log('\nCAVEATS:');
  console.log('  - Numbers are for THIS dev machine, not EC2 r6i.large.');
  console.log('  - RSS includes Node + Chromium shared memory (estimate).');
  console.log('  - Concurrency=1; parallel renders multiply memory use.');
  console.log('===========================================\n');
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
