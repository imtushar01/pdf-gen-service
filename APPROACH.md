# Approach Document

## 1. Initial Understanding

> Before using any AI tools or doing research, what was your initial read of
> this problem? What did you think the hard parts were?

My first read: this looks like a simple "HTML → PDF" wrapper, but the scenario
constraints are where the real engineering is. The PDF generation itself
(Puppeteer + a template) is the easy 20%. The hard 80% is everything around it:

- **It can't be synchronous.** 2–3 seconds per render at ~1,000 requests/min
  means any request-blocking design collapses under load. So there has to be a
  queue and a background worker, and the API has to return a job ID and let the
  client poll.
- **Chromium is a memory hog.** ~400 MB per render means you can't just render
  everything in parallel — you'll OOM. Concurrency has to be bounded, and the
  worker should be isolated from the API so rendering pressure doesn't take
  down request handling.
- **The "87th PDF" data-consistency point is the most interesting constraint.**
  It's really asking: at what moment is the data for a document frozen? My
  instinct was to snapshot the input the moment a request is accepted, and
  render only from the snapshot.
- **Unreliable downloads** screamed "HTTP Range requests / resumable
  downloads." I'd seen `curl -C -` do this; the server side is the 206 /
  Content-Range dance.
- **Tamper evidence** felt like it could be over-engineered into PKI signing.
  My instinct was that a stored SHA-256 is the proportionate answer, as long as
  I'm honest about what it does and doesn't prove.
- **The budget (₹12,500 / ~$150 for 30k PDFs)** told me this is a small/medium
  deployment — not a reason to reach for Kubernetes and autoscaling fleets.

The parts I expected to be genuinely hard: idempotency under concurrent
duplicate requests, the database-to-queue consistency gap (job saved but not
enqueued), and finalizing a bulk ZIP exactly once when many workers finish at
the same time.

---

## 2. Assumptions & Clarifying Questions

> List any assumptions you made. In a real scenario, what questions would you
> ask the product team or engineering lead before starting?

**Assumptions made:**

1. A working implementation is valuable even though the brief says code is
   optional — a running, tested system is more defensible than a diagram.
2. Authentication between the ERP and this service is a shared **service API
   key** (`X-API-Key`). The ERP is a trusted internal caller, not an end user.
3. **Totals are derived and verified**, not trusted. The service recomputes
   `subtotal = Σ(quantity × unitPrice)` and rejects a payload whose stated
   total disagrees. This catches both ERP bugs and tampering.
4. The immutable snapshot's guarantee is "we render exactly the payload you
   sent at acceptance time." We do **not** guarantee the ERP assembled that
   payload atomically from its own DB — that's the ERP's responsibility.
5. Local filesystem storage is acceptable for the assessment; production swaps
   in S3 behind the same interface.
6. "Archived for compliance" means we persist artifacts + checksums; a formal
   retention/WORM policy is out of scope but noted.

**Questions I'd ask a real product/eng lead:**

- Does the ERP need a webhook/callback on completion, or is polling fine?
- What's the retention requirement for generated PDFs (30 days? 7 years for GST
  invoices)? This drives storage-class and cost decisions.
- Is there a hard SLA on bulk completion, or is "reasonable time" literal?
- Should totals be authoritative from the ERP, or is the service allowed to be
  the source of truth? (I chose verify-and-reject; worth confirming.)
- Do invoices ever embed images/logos (external resources), or is text-only
  rendering acceptable? (I block external network access for safety.)
- What's the real tamper-evidence requirement — detect accidental corruption,
  or legally defensible non-repudiation? (Very different solutions.)

---

## 3. Capacity Planning & Math

> Show your calculations. How did you arrive at your resource requirements?
> Consider: memory, CPU, storage, network bandwidth, queue depth.

**Inputs (from the brief, treated as hypotheses, not measurements):**

- ~1,000 single requests/min at peak; 5–10 bulk/min.
- ~2–3 s/render, ~400 MB/render.
- Individual PDFs 100 KB–1 MB; ~30,000 PDFs/month.

**Render throughput per slot (using the brief's 2.5 s average):**

```
1 render slot  = 60 s / 2.5 s      = 24 PDFs/min
4 render slots = 4 × 24            = 96 PDFs/min
```

**The gap:** peak demand is ~1,000 PDFs/min. Even 4 continuously-busy slots do
~96/min. To meet 1,000/min with rendering alone:

```
1000 / 24 ≈ 42 concurrent render slots
42 slots × 400 MB ≈ 16.8 GB of rendering memory  (before OS + Node overhead)
```

That exceeds a single r6i.large (16 GB total). **So a single box cannot sustain
1,000 PDFs/min of continuous rendering.** This is the key finding.

**Why that's usually fine — peak vs sustained:**

```
Monthly volume:     30,000 PDFs
Even spread:        30,000 / 30 days ≈ 1,000/day ≈ 42/hour ≈ 0.7/min
```

The sustained average (~0.7/min) is tiny. The 1,000/min figure is a *burst*.
A queue absorbs bursts: requests are accepted instantly (202) and drained at
the worker's sustainable rate. Queue depth grows during a burst and shrinks
after. Little's Law: `L = λ × W` — if arrivals (λ) exceed service rate for a
sustained period, the queue (L) grows without bound, so **queueing fixes bursts,
not sustained under-capacity.** For this workload the burst is short and the
average is low, so a modest worker pool is adequate.

**Measured on the dev machine (actual numbers, `npm run benchmark`):**

| Document | Mean render | Single-slot throughput |
|----------|-------------|------------------------|
| Small invoice (2 items) | ~110 ms | ~544 PDFs/min |
| Large invoice (500 items) | ~863 ms | ~70 PDFs/min |
| Peak process RSS | ~403 MB | — |

The ~403 MB peak **validates the brief's ~400 MB assumption**. The latency is
much faster than 2.5 s because this is Apple Silicon, not an r6i.large — I do
**not** claim these numbers hold on the target hardware.

**Storage:**

```
30,000 PDFs/month × ~300 KB avg ≈ 9 GB/month added
```

Cheap (see §8). The concern is cumulative growth under long retention, not
monthly rate.

**Network:** 9 GB/month out is trivial. Bulk ZIP downloads over flaky links are
the real network concern — addressed with Range/resume, not bandwidth.

**Worker sizing recommendation:** run the worker with concurrency 2–4 on a
small dedicated instance (not the ERP box, which has no spare memory for
Chromium). 4 slots ≈ 1.6 GB rendering memory + overhead fits a 4 GB instance.

---

## 4. Design Decisions

### Decision 1: Asynchronous jobs + queue (not synchronous rendering)

**Alternatives considered:**
- Synchronous: block the HTTP request until the PDF is ready.
- Hybrid: sync for small docs, async for bulk.
- Fully async: accept → 202 → queue → worker → poll/download.

**Chosen approach:** fully asynchronous for everything.

**Why:** at 1,000 req/min with 2–3 s renders, synchronous handling exhausts
connections and hits gateway timeouts. A hybrid adds routing complexity and two
code paths to test for marginal UX gain. Fully async is one model, absorbs
bursts, and isolates slow rendering from fast acceptance.

**Tradeoff accepted:** clients must poll for status instead of getting the PDF
in one call. More moving parts (queue, worker, status endpoints). Worth it for
load tolerance.

### Decision 2: BullMQ + Redis for the queue

**Alternatives considered:**
- BullMQ on Redis (Redis already exists in the ERP stack).
- A PostgreSQL-backed queue (e.g. pg-boss) — no new infrastructure.
- AWS SQS — managed, but paid and a different API.

**Chosen approach:** BullMQ + Redis.

**Why:** Redis is already in the stack, BullMQ has first-class NestJS
integration, built-in retries/backoff, and delayed jobs. A Postgres queue would
avoid new infra but adds polling latency and load to the same DB that stores
business data. SQS is **not** a drop-in BullMQ backend — it's a wholly different
API — so it's a production *migration*, not a swap.

**Tradeoff accepted:** Redis durability must be configured (AOF enabled in
`docker-compose.yml`); a Redis outage stops new rendering until recovery. We
mitigate the "saved-but-not-enqueued" gap with a reconciler (Decision 6).

### Decision 3: Immutable input snapshots for data consistency

**Alternatives considered:**
- Worker re-fetches data from the ERP at render time.
- Snapshot the full payload at acceptance; render only from the snapshot.
- Version/timestamp the ERP data and pin a version.

**Chosen approach:** snapshot the exact payload in the same DB transaction as
the job, and render only from it.

**Why:** this directly solves the "87th PDF showed stale data" problem. If the
worker re-fetched, document #87 (rendered 3 minutes later) could differ from #1.
With a snapshot, every document in a batch reflects the data as it was when the
batch was submitted. Versioning the ERP data would require changing the ERP,
which the brief forbids.

**Tradeoff accepted:** storage of the input JSON per job, and the explicit
boundary that we guarantee "renders what you sent," not "what the ERP's DB held
at some instant." Documented clearly so it isn't oversold.

### Decision 4: Storage behind an interface (filesystem now, S3 later)

**Alternatives considered:**
- Write directly to the filesystem from the worker.
- MinIO (self-hosted S3) locally.
- An `IStorageService` interface with a filesystem adapter now, S3 later.

**Chosen approach:** the interface + filesystem adapter, with atomic writes and
streaming SHA-256.

**Why:** the brief requires storage to be replaceable "without rewriting the
business workflow." The interface is the Open/Closed seam — the worker, download
controller, and ZIP builder depend on `IStorageService`, never on `fs` or an S3
SDK. Swapping to S3 is one line in the module. MinIO would be more realistic
but adds a container for no assessment benefit.

**Tradeoff accepted:** filesystem storage is single-node — not durable or
shareable across instances. Explicitly documented as a production limitation.

### Decision 5: Race-safe bulk finalization via a conditional DB update

**Alternatives considered:**
- Each worker checks "am I last?" and builds the ZIP if so (racy).
- A distributed lock (Redlock) around finalization.
- An atomic conditional status transition `PROCESSING → FINALIZING`.

**Chosen approach:** the atomic conditional update. `updateMany(where status =
PROCESSING)` sets `FINALIZING`; exactly one caller affects a row (count = 1),
everyone else sees count = 0 and returns.

**Why:** when 100 child jobs finish near-simultaneously across workers, several
can believe they're "last." A naive check builds the ZIP twice. The DB already
gives us a single serialization point, so a conditional update is simpler and
cheaper than adding Redlock and reasoning about lock expiry.

**Tradeoff accepted:** if the winner crashes mid-ZIP, the batch is stuck in
`FINALIZING` — handled by the recovery reconciler, which reverts it and retries.

### Decision 6: Recovery reconciler over a transactional outbox

**Alternatives considered:**
- Transactional outbox: write job + "enqueue intent" in one tx, a relay
  enqueues from the outbox.
- A periodic reconciler that heals stuck states.

**Chosen approach:** the reconciler.

**Why:** our design already makes re-enqueue safe — the BullMQ job ID equals the
DB job ID, so re-adding an already-queued job is a no-op. That removes the main
thing an outbox buys you (exactly-once hand-off) and lets a simple periodic
sweep close the database-to-queue gap, reset stale `PROCESSING` jobs, and retry
stuck `FINALIZING` batches. An outbox is more machinery (table, relay, dedup)
than this scale needs.

**Tradeoff accepted:** recovery is eventually-consistent (up to ~1 minute), not
instantaneous. For a document service that's fine. The outbox is noted as a
future improvement if stricter guarantees are ever required.

---

## 5. AI Usage Log

> Public links of conversations you had with AI.


---

## 6. Weaknesses & Future Improvements

> What is the weakest part of your design? If you had 2 more days, what would
> you improve? What would you change for 10x load?

**Weakest part:** local filesystem storage. It's single-node, not durable, and
invisible across instances. It's fine for the assessment but is the first thing
to replace in production.

**Other honest weaknesses:**
- Recovery is a periodic sweep (≤1 min latency), not a transactional outbox.
- Tamper evidence is a stored SHA-256 — it detects byte changes only while the
  reference hash is protected. It is not a digital signature and provides no
  non-repudiation.
- No rate limiting on the API itself (the brief says the ERP already has Redis
  rate limiting upstream; I'd still add a safety limiter in production).
- Load testing covered API acceptance rate; I did not run a sustained
  render-throughput soak test on representative hardware.

**With 2 more days:**
1. S3 storage adapter + a swap based on config, with lifecycle rules.
2. A render soak test and a dead-letter queue for exhausted jobs with alerting.
3. Webhook/callback on completion so the ERP doesn't have to poll.
4. Metrics endpoint (Prometheus) for queue depth, render latency, failure rate.

**For 10x load (10,000 PDFs/min bursts, 300k/month):**
- Move storage to S3 and run **multiple stateless worker instances** behind the
  same Redis queue — horizontal scaling is the whole point of the async design.
- Autoscale workers on queue depth.
- Consider a managed queue (SQS/managed Redis) to remove Redis as a single
  point of failure.
- Partition/retain artifacts by date; push cold artifacts to cheaper storage
  classes.

---

## 7. One Thing the Problem Statement Didn't Mention

> What's something important for a production deployment that wasn't called out?
> Why does it matter?

**Artifact retention and lifecycle.** The brief says PDFs "may need to be
archived for compliance" but never states *how long*. For GST invoices in
India, records are commonly retained for several years. This single unknown
dominates the storage cost and architecture:

- At 30k PDFs/month × ~300 KB, you add ~9 GB/month. Over 7 years that's ~750 GB
  — still cheap on S3 Standard (~$17/month), but it changes the design: you'd
  want lifecycle rules to move old artifacts to S3 Infrequent-Access or Glacier,
  and you'd need a documented deletion policy for anything *not* under a legal
  hold.
- It also affects the database: `artifact` metadata rows accumulate forever
  unless pruned, and the reconciler/queries must stay efficient as tables grow.

It matters because getting retention wrong is either a **compliance failure**
(deleting too early) or a **cost/perf problem** (keeping everything hot
forever). I'd push to pin this down before launch.

A close second: **observability and alerting.** The brief asks for logging but
not for alerts on queue depth or failure spikes — which is what you actually
need at 3am when rendering backs up.

---

## 8. Cost Estimation

> Line-by-line monthly cost. Show your math. Reasoning over exact numbers.

Workload: ~30,000 PDFs/month, ~300 KB average, modest sustained rate with
occasional bursts. Prices are verified for AWS **ap-south-1 (Mumbai)** / US
regions as noted (Oct 2026); treat as estimates, not a bill.

**Key insight:** the brief's existing ERP box (r6i.large, 16 GB) has **no spare
memory** for Chromium workers. So the new cost is a small **dedicated worker
instance** plus storage and a little data transfer. The existing Postgres (RDS)
and Redis are reused — no new DB/cache cost attributed to this service.

| Line item | Basis | Monthly |
|-----------|-------|---------|
| Worker compute: 1 × `t4g.medium` (2 vCPU, 4 GB) on-demand, 24×7 | $0.0224/hr × 730 hr (ap-south-1) | **~$16.4** |
| Artifact storage: S3 Standard, ~9 GB added/month (steady-state small while retention is short) | ~$0.023/GB (us-east-1 ref) × ~9 GB | **~$0.21** |
| S3 writes: ~30,000 PUTs/month | ~$0.005 / 1,000 PUT × 30 | **~$0.15** |
| S3 reads: assume ~2× downloads = ~60,000 GETs | ~$0.0004 / 1,000 GET × 60 | **~$0.02** |
| Data transfer out: ~18 GB/month (downloads) | first 100 GB tier; ~$0.09/GB US ref | **~$1.6** |
| Reuse existing RDS Postgres + Redis | shared with ERP, no new cost | $0 |
| **Total (new cost for this service)** | | **≈ $18–20 / month** |

**Against the ceiling (~$150 / ₹12,500):** comfortably under — roughly
**12–13%** of budget. That's expected: the sustained workload is small; the big
numbers in the brief are *peak bursts*, which the queue absorbs on a single
cheap worker.

**Caveats / where this grows:**
- **Reserved/Savings Plan** on the worker would cut ~30–40% off compute.
- Storage cost is small *now* but grows linearly with retention. Over multiple
  years with no lifecycle policy, S3 becomes the dominant line (still well
  within budget at this volume, but worth watching — see §7).
- If bursts become sustained (real 1,000/min for long periods), you'd add
  worker instances; each `t4g.medium` is ~$16/month, so even 4 workers (~$66)
  plus storage stays under $150.
- Prices verified via AWS/third-party pricing references (Oct 2026); exact
  ap-south-1 S3 and transfer rates differ slightly from the US references used
  where a Mumbai figure wasn't confirmed — I've flagged which is which.
