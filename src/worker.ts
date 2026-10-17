/**
 * worker.ts — Worker process entrypoint
 *
 * This is a SEPARATE process from the API (main.ts). Run it with:
 *   npm run worker          (production: node dist/worker)
 *   npm run worker:dev      (development: ts-node src/worker.ts)
 *
 * Why separate?
 * Chromium rendering uses ~400 MB per concurrent render. Running the worker
 * in its own process means that memory pressure cannot starve the API's
 * ability to accept requests and answer health checks. They can also be
 * scaled independently — e.g. run 1 API and 3 workers.
 *
 * This process has NO HTTP server. It uses NestFactory.createApplicationContext
 * (not .create) because it only needs the DI container and the BullMQ worker,
 * not an Express listener.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './queue/worker.module';
import { JsonLogger } from './common/logging/json-logger.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // createApplicationContext: DI container without an HTTP server.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new JsonLogger(),
  });

  // Enable graceful shutdown hooks so onModuleDestroy runs (closes Puppeteer,
  // disconnects Prisma, drains the BullMQ worker) on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  logger.log('PDF render worker started and listening for jobs');

  // Keep the process alive. The BullMQ worker runs in the background.
  // Graceful shutdown on signals:
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down worker gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start worker:', err);
  process.exit(1);
});
