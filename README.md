# PDF Generation Microservice

A standalone HTTP microservice that generates PDF documents (invoices and
purchase orders) for an ERP application. It supports single-document and bulk
(up to 100) generation, asynchronous processing with a background worker,
resumable downloads, and tamper-evident artifacts.

Built with NestJS + TypeScript, PostgreSQL (Prisma), Redis (BullMQ), and
Puppeteer. Everything runs locally and free via Docker Compose.

> **Assessment note:** This repository is a take-home submission. The most
> important document is [`APPROACH.md`](./APPROACH.md), which explains the
> reasoning, trade-offs, capacity math, and honest weaknesses. The
> architecture diagram is [`architecture-diagram.png`](./architecture-diagram.png)
> (Mermaid source in [`docs/architecture.md`](./docs/architecture.md)).

---

## Features

- **Single + bulk generation** — one PDF, or a batch of up to 100.
- **Asynchronous processing** — the API accepts a job (202) and a separate
  worker process renders it. Chromium memory pressure can't starve the API.
- **Immutable input snapshots** — each job freezes its input at acceptance
  time, so bulk documents never render stale data (the "87th PDF" problem).
- **Idempotency** — duplicate requests return the existing job; a reused key
  with a different payload is rejected (409).
- **Large documents** — 500+ line-item documents are rendered in chunks and
  merged, avoiding Puppeteer OOM crashes.
- **Resumable downloads** — HTTP Range support for both PDFs and ZIPs, so
  downloads survive unreliable connections without restarting from zero.
- **Tamper evidence** — SHA-256 checksum stored per artifact, verifiable on
  demand.
- **Partial bulk failure** — the ZIP contains every successful PDF plus a
  `failures.json` manifest for the rest.
- **Crash recovery** — a reconciler re-enqueues orphaned/stale jobs and
  retries stuck batch finalizations.
- **Structured logging, Swagger docs, 90+ tests.**

---

## Tech stack

| Concern | Choice |
|---------|--------|
| API framework | NestJS 10 + TypeScript 5 |
| Validation | class-validator + class-transformer |
| API docs | NestJS Swagger (`/api/docs`) |
| Database | PostgreSQL 16 |
| ORM / migrations | Prisma 5 |
| Queue | BullMQ 5 on Redis 7 |
| PDF rendering | Puppeteer (headless Chromium) |
| Templating | Handlebars (auto-escaped) |
| Large-doc merge | pdf-lib |
| ZIP | archiver |
| Checksums | Node.js `crypto` (SHA-256) |
| Storage | Filesystem adapter behind an interface (S3-ready) |
| Tests | Jest + Supertest |
| Load test | k6 |
| Local infra | Docker Compose |

See `APPROACH.md` for why each was chosen over the alternatives.

---

## Prerequisites

- **Node.js 20+** (developed on Node 24)
- **Docker + Docker Compose** (for PostgreSQL and Redis)
- No cloud account or paid service is required.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy the environment template and review it
cp .env.example .env
#    The defaults work with the Docker Compose setup below.
#    Set a strong API_KEY for anything beyond local dev.

# 3. Start PostgreSQL and Redis
docker compose up -d

# 4. Apply database migrations
npm run db:migrate
```

> **Note on ports:** Docker Compose maps PostgreSQL to host port **5434** and
> Redis to **6380** (to avoid clashing with other local services). The
> `.env.example` already matches these.

---

## Running

The service runs as **two processes**: the API and the worker. Start both.

```bash
# Terminal 1 — API (HTTP server)
npm run start:dev

# Terminal 2 — Worker (renders PDFs from the queue)
npm run worker:dev
```

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/api/docs`
- Health: `http://localhost:3000/health` (unauthenticated)

For production builds:

```bash
npm run build
npm run start:prod   # API
npm run worker       # worker (separate process / container)
```

---

## Authentication

Every endpoint except `/health` requires a header:

```
X-API-Key: <value of API_KEY from your .env>
```

---

## API quick reference

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | Liveness + DB readiness (no auth) |
| POST | `/api/v1/jobs` | Create a single-document job |
| GET  | `/api/v1/jobs/:id` | Job status |
| GET  | `/api/v1/jobs/:id/download` | Download the PDF (Range-aware) |
| GET  | `/api/v1/jobs/:id/checksum` | Stored checksum + verification |
| POST | `/api/v1/batches` | Create a bulk batch (≤100 docs) |
| GET  | `/api/v1/batches/:id` | Batch status + per-item progress |
| GET  | `/api/v1/batches/:id/download` | Download the ZIP (Range-aware) |

### Create a single job

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "X-API-Key: dev-only-api-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{
    "documentType": "INVOICE",
    "idempotencyKey": "demo-inv-001",
    "data": {
      "invoiceNumber": "INV-2026-001",
      "invoiceDate": "2026-10-17",
      "sellerName": "Acme Corp",
      "sellerAddress": "123 Industrial Area, Bangalore",
      "buyerName": "TechStart Solutions",
      "buyerAddress": "456 Tech Park, Hyderabad",
      "currency": "INR",
      "lineItems": [
        { "description": "Server hosting", "quantity": 5, "unitPrice": 1500, "amount": 7500 }
      ],
      "taxRate": 18,
      "totalAmount": 8850
    }
  }'
# → 202 Accepted  { "id": "...", "status": "PENDING", ... }
```

### Poll status, then download

```bash
JOB_ID=... # from the create response

curl http://localhost:3000/api/v1/jobs/$JOB_ID \
  -H "X-API-Key: dev-only-api-key-change-in-production"
# → { "status": "COMPLETED", ... }

# Download the PDF
curl -o invoice.pdf http://localhost:3000/api/v1/jobs/$JOB_ID/download \
  -H "X-API-Key: dev-only-api-key-change-in-production"

# Verify the checksum
curl http://localhost:3000/api/v1/jobs/$JOB_ID/checksum \
  -H "X-API-Key: dev-only-api-key-change-in-production"
# → { "sha256": "...", "verified": true }
```

### Resume an interrupted download (HTTP Range)

```bash
# Fetch only bytes 1000 onward (what curl -C - does under the hood)
curl -H "Range: bytes=1000-" \
  http://localhost:3000/api/v1/jobs/$JOB_ID/download \
  -H "X-API-Key: dev-only-api-key-change-in-production"
# → 206 Partial Content
```

### Create a bulk batch

```bash
curl -X POST http://localhost:3000/api/v1/batches \
  -H "X-API-Key: dev-only-api-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "demo-batch-001",
    "items": [
      { "documentType": "INVOICE", "data": { ... } },
      { "documentType": "PURCHASE_ORDER", "data": { ... } }
    ]
  }'
# → 202 Accepted { "id": "...", "totalCount": 2, "status": "PENDING" }

# Poll, then download the ZIP when zipReady is true
curl -o batch.zip http://localhost:3000/api/v1/batches/<batchId>/download \
  -H "X-API-Key: dev-only-api-key-change-in-production"
```

---

## Testing

```bash
# Unit + integration tests (needs docker compose up for the DB/Redis-backed ones)
npm test

# End-to-end tests (API + worker against real Postgres/Redis)
npm run test:e2e

# Measure real render latency + memory on your machine
npm run benchmark

# Load test the API acceptance rate (requires k6 installed)
API_KEY=dev-only-api-key-change-in-production k6 run scripts/load-test.js
```

Measured benchmark results for the development machine are in
[`scripts/BENCHMARK_RESULTS.md`](./scripts/BENCHMARK_RESULTS.md).

---

## Project structure

```
src/
  main.ts                  API entrypoint
  worker.ts                Worker entrypoint (separate process)
  config/                  Env config + Joi validation
  common/                  Guard, filter, interceptor, logger, utils
  health/                  Health endpoint
  prisma/                  PrismaService + module
  documents/               DTOs + document validation
  renderer/                Puppeteer renderer + Handlebars templates
  jobs/                    Single-job API + orchestration (producer)
  storage/                 IStorageService + filesystem adapter
  artifacts/               Artifact metadata + checksum verification
  downloads/               Range-aware download endpoints
  queue/                   BullMQ queue, processor, worker module
  batches/                 Bulk batches + ZIP builder
  recovery/                Crash-recovery reconciler
prisma/                    schema.prisma + migrations
scripts/                   benchmark + k6 load test
docs/                      architecture (Mermaid)
test/integration/          integration + e2e tests
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `API_KEY is required` on startup | Copy `.env.example` to `.env` and set `API_KEY`. |
| DB connection refused | `docker compose up -d`; confirm port 5434 is free. |
| Port 5434/6380 already allocated | Another container uses it — edit `docker-compose.yml` and `.env` to a free port. |
| Jobs stay `PENDING` | Start the worker (`npm run worker:dev`). The reconciler also re-enqueues after ~30s. |
| Puppeteer fails to launch | Ensure the Chromium download during `npm install` completed; re-run `npm install`. |
| Health shows `degraded` | The database is unreachable — check the `checks.database` field. |

---

## Known limitations

See `APPROACH.md` §6 for the full, honest list. In short:

- **Local filesystem storage** is single-node only; production needs S3.
- **Capacity**: this local setup does not sustain 1,000 PDFs/min — see the
  capacity math. Queueing absorbs bursts, not sustained under-capacity.
- **Tamper evidence** is checksum-based, not a digital signature.
- **Database-to-queue consistency** uses a recovery reconciler, not a full
  transactional outbox.
