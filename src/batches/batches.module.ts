/**
 * batches.module.ts
 *
 * Provides bulk batch orchestration. Imported by BOTH:
 *   - AppModule (API): exposes the controller for HTTP
 *   - WorkerModule: the processor injects BatchesService to notify on
 *     child-job completion and trigger finalization
 *
 * Registers the PDF queue so BatchesService can enqueue child jobs.
 * Imports DocumentsModule (validation) and ArtifactsModule (artifact lookup).
 * StorageModule is @Global, so STORAGE_SERVICE is available for ZipBuilder.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';
import { ZipBuilderService } from './zip-builder.service';
import { DocumentsModule } from '../documents/documents.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { PDF_QUEUE } from '../queue/queue.constants';

@Module({
  imports: [
    DocumentsModule,
    ArtifactsModule,
    BullModule.registerQueue({ name: PDF_QUEUE }),
  ],
  controllers: [BatchesController],
  providers: [BatchesService, ZipBuilderService],
  exports: [BatchesService],
})
export class BatchesModule {}
