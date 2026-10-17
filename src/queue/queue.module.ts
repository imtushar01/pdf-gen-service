/**
 * queue.module.ts
 *
 * Configures the BullMQ connection to Redis and registers the PDF render queue.
 *
 * @Global() so both the API (producer) and worker (consumer) can inject
 * the queue without re-importing this module everywhere.
 *
 * ── Default job options ────────────────────────────────────────────────────
 * attempts: 3           → BullMQ retries a failed job up to 3 times total.
 * backoff: exponential  → wait 2s, then 4s, then 8s between retries. This
 *                         gives transient problems (Redis blip, brief OOM)
 *                         time to clear instead of hammering immediately.
 * removeOnComplete       → keep the last 1000 completed jobs for inspection,
 *                         then auto-trim so Redis memory doesn't grow forever.
 * removeOnFail: false    → keep failed jobs so we can inspect why they failed.
 *
 * The retry/terminal distinction lives in the processor: we only write
 * FAILED to the database when BullMQ has exhausted all attempts.
 */
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PDF_QUEUE } from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redisHost') ?? 'localhost',
          port: config.get<number>('redisPort') ?? 6379,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: false,
        },
      }),
    }),
    BullModule.registerQueue({
      name: PDF_QUEUE,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
