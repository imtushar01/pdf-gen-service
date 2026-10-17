# Benchmark Results

These are **actual measured numbers** from running `npm run benchmark` on the
development machine. They are NOT numbers for the target production hardware
(EC2 r6i.large). See the caveats at the bottom.

## Environment

- Machine: Apple Silicon (arm64), macOS
- Node: v24.22.0
- Render concurrency during benchmark: 1 (single slot, to isolate per-render cost)
- Chromium: bundled with Puppeteer 23

## Render latency

| Document | Runs | min | mean | p95 | max | Single-slot throughput |
|----------|------|-----|------|-----|-----|------------------------|
| Small invoice (2 line items)      | 20 | 89 ms  | ~110 ms | 300 ms | 300 ms | ≈ 544 PDFs/min |
| Large invoice (500 items, chunked) | 5  | 801 ms | ~863 ms | 915 ms | 915 ms | ≈ 70 PDFs/min  |

## Memory

| Metric | Value |
|--------|-------|
| Process RSS at start | ~47 MB |
| Process RSS peak during benchmark | ~403 MB |
| Delta (Chromium + rendering) | ~356 MB |

The peak RSS of ~403 MB closely matches the assessment's stated
"~400 MB temporary memory per rendering operation" — a useful validation of
that assumption.

## What these numbers prove and do NOT prove

PROVES (on this dev machine):
- A single render slot sustains ~544 small PDFs/min or ~70 large PDFs/min.
- One concurrent render peaks around ~400 MB RSS.
- The 500-line-item chunked path renders without OOM (previously crashed
  Puppeteer per the assessment's constraint).

DOES NOT PROVE:
- Performance on EC2 r6i.large. Apple Silicon is significantly faster than
  that instance; the assessment's 2.5 s/render assumption is more realistic
  for the target hardware. Production numbers must be measured on production.
- Sustained 1,000 PDFs/min. See the capacity math in APPROACH.md — queueing
  absorbs bursts but cannot fix sustained under-capacity.

## How to reproduce

```bash
docker compose up -d        # not required for the benchmark itself
npm run benchmark
```
