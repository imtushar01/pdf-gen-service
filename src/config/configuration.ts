/**
 * configuration.ts
 *
 * Central typed configuration.
 * All environment variables are validated by Joi at startup (see app.module.ts).
 * Access via NestJS ConfigService — never read process.env directly in business logic.
 *
 * Why: Fail-fast at startup if required env vars are missing, not at first use.
 */
export default () => ({
  // ─── Server ───────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // ─── Security ─────────────────────────────────────────────────────────
  // Used by ApiKeyGuard. Clients must send: X-API-Key: <value>
  apiKey: process.env.API_KEY,

  // ─── Database ─────────────────────────────────────────────────────────
  databaseUrl: process.env.DATABASE_URL,

  // ─── Redis / Queue ────────────────────────────────────────────────────
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT ?? '6379', 10),

  // ─── Artifact Storage ─────────────────────────────────────────────────
  // Local filesystem path where generated PDFs and ZIPs are stored.
  // Replace with S3 bucket config for production deployment.
  artifactsDir: process.env.ARTIFACTS_DIR ?? './artifacts',

  // ─── Rendering ────────────────────────────────────────────────────────
  // Max concurrent Puppeteer renders. Controls Chromium memory pressure.
  // 4 workers × ~400 MB = ~1.6 GB peak rendering memory.
  renderConcurrency: parseInt(process.env.RENDER_CONCURRENCY ?? '4', 10),

  // Chromium render timeout in milliseconds. Prevents zombie renders.
  renderTimeoutMs: parseInt(process.env.RENDER_TIMEOUT_MS ?? '30000', 10),

  // Maximum line items per rendered chunk. Documents above this are split.
  // Prevents OOM for 500+ line-item documents (see renderer service).
  renderChunkSize: parseInt(process.env.RENDER_CHUNK_SIZE ?? '100', 10),
});
