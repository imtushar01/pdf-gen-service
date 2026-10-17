/**
 * recovery.module.ts
 *
 * Provides the periodic reconciler. Loaded by the WORKER process only —
 * the API does not run recovery sweeps. Registers the PDF queue (to
 * re-enqueue) and imports BatchesModule (to retry finalization).
 *
 * The @nestjs/schedule ScheduleModule.forRoot() enables @Cron decorators.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { RecoveryService } from './recovery.service';
import { BatchesModule } from '../batches/batches.module';
import { PDF_QUEUE } from '../queue/queue.constants';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue({ name: PDF_QUEUE }),
    BatchesModule,
  ],
  providers: [RecoveryService],
  exports: [RecoveryService],
})
export class RecoveryModule {}
