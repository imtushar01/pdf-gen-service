/**
 * jobs.module.ts
 *
 * Wires up the jobs feature: controller + service.
 * Imports DocumentsModule for validation and registers the PDF queue so
 * JobsService can act as a producer (enqueue render jobs).
 *
 * JobsService is exported for reuse by BatchesModule (M8) and the worker.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { DocumentsModule } from '../documents/documents.module';
import { PDF_QUEUE } from '../queue/queue.constants';

@Module({
  imports: [DocumentsModule, BullModule.registerQueue({ name: PDF_QUEUE })],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
