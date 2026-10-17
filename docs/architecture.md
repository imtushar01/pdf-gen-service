# Architecture

Mermaid source for the system architecture. GitHub renders this inline.
A rendered `architecture-diagram.png` is also committed at the repo root
for the assessment submission.

## System overview

```mermaid
flowchart TB
    ERP["Django ERP Monolith<br/>(EC2 r6i.large)<br/>existing — not re-architected"]

    subgraph PDFService["PDF Generation Microservice"]
        direction TB
        API["API Process<br/>(NestJS HTTP)<br/>main.ts"]
        Worker["Worker Process<br/>(BullMQ consumer)<br/>worker.ts"]
    end

    subgraph Datastores["Data & Infrastructure"]
        PG[("PostgreSQL<br/>jobs, batches, snapshots,<br/>artifacts, zip metadata")]
        Redis[("Redis<br/>BullMQ queue")]
        Storage["Artifact Storage<br/>(filesystem adapter today,<br/>S3 in production)"]
    end

    ERP -->|"1. POST /jobs or /batches<br/>X-API-Key"| API
    API -->|"2. validate + persist job<br/>+ immutable snapshot (tx)"| PG
    API -->|"3. enqueue jobId"| Redis
    API -->|"202 Accepted + job/batch id"| ERP

    Redis -->|"4. deliver job"| Worker
    Worker -->|"5. load snapshot"| PG
    Worker -->|"6. render PDF<br/>(Chromium, bounded concurrency)"| Worker
    Worker -->|"7. atomic write + SHA-256"| Storage
    Worker -->|"8. record artifact + status COMPLETED"| PG

    ERP -->|"9. GET /jobs/:id (poll status)"| API
    ERP -->|"10. GET /jobs/:id/download<br/>(HTTP Range, resumable)"| API
    API -->|"stream bytes"| Storage

    Worker -.->|"recovery reconciler<br/>(cron, re-enqueue stuck jobs)"| PG
    Worker -.->|"on last child: build + persist ZIP"| Storage
```

## Single-document flow (async)

```mermaid
sequenceDiagram
    participant ERP
    participant API
    participant DB as PostgreSQL
    participant Q as Redis/BullMQ
    participant W as Worker
    participant S as Storage

    ERP->>API: POST /jobs (X-API-Key, invoice JSON)
    API->>API: validate document + totals
    API->>DB: BEGIN tx: create Job + InputSnapshot
    API->>DB: COMMIT
    API->>Q: enqueue { jobId } (jobId == DB id)
    API-->>ERP: 202 Accepted { id, status: PENDING }

    Q->>W: deliver job
    W->>DB: load Job + snapshot
    alt already COMPLETED
        W-->>Q: ack (idempotent skip)
    else render
        W->>DB: status = PROCESSING
        W->>W: render PDF (Chromium)
        W->>S: atomic write + SHA-256
        W->>DB: create Artifact + status = COMPLETED
    end

    ERP->>API: GET /jobs/:id (poll)
    API-->>ERP: { status: COMPLETED }
    ERP->>API: GET /jobs/:id/download (Range: bytes=...)
    API->>S: read stream (range)
    API-->>ERP: 206 Partial Content (resumable)
```

## Bulk batch flow with race-safe finalization

```mermaid
sequenceDiagram
    participant ERP
    participant API
    participant DB as PostgreSQL
    participant Q as Redis/BullMQ
    participant W as Workers (N)
    participant S as Storage

    ERP->>API: POST /batches (up to 100 docs)
    API->>API: validate ALL documents
    API->>DB: BEGIN tx: Batch + N Jobs + N snapshots + N items
    API->>DB: COMMIT
    API->>Q: enqueue N child jobs
    API-->>ERP: 202 Accepted { batchId, totalCount }

    loop each child job
        Q->>W: deliver child job
        W->>S: render + store PDF
        W->>DB: child COMPLETED/FAILED
        W->>DB: atomic increment completed/failed count
        alt all children done
            W->>DB: conditional claim PROCESSING->FINALIZING
            Note over W,DB: only ONE worker wins the claim
            W->>S: stream-build ZIP (+ failures.json)
            W->>DB: create ZipArtifact + final status
        end
    end

    ERP->>API: GET /batches/:id (poll progress)
    API-->>ERP: { completedCount, failedCount, zipReady }
    ERP->>API: GET /batches/:id/download (Range)
    API-->>ERP: ZIP (206 resumable)
```

## Job & batch state machines

```mermaid
stateDiagram-v2
    direction LR
    state "Job" as J {
        [*] --> PENDING
        PENDING --> PROCESSING: worker claims
        PROCESSING --> COMPLETED: render + store ok
        PROCESSING --> PENDING: retryable error (BullMQ retry)
        PROCESSING --> FAILED: terminal error / retries exhausted
        COMPLETED --> [*]
        FAILED --> [*]
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state "Batch" as B {
        [*] --> PENDING
        PENDING --> PROCESSING: first child starts
        PROCESSING --> FINALIZING: last child done (atomic claim)
        FINALIZING --> COMPLETED: all succeeded
        FINALIZING --> PARTIAL_FAILURE: some failed
        FINALIZING --> FAILED: all failed
        FINALIZING --> PROCESSING: finalize crashed (recovery)
        COMPLETED --> [*]
        PARTIAL_FAILURE --> [*]
        FAILED --> [*]
    }
```
