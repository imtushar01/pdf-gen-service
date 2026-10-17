/**
 * worker.module.ts
 *
 * The module loaded by the SEPARATE worker process (worker.ts).
 *
 * It deliberately does NOT import controllers or the HTTP layer — the worker
 * has no HTTP server. It loads only what the render pipeline needs:
 *   - ConfigModule    (env config)
 *   - PrismaModule    (database)
 *   - QueueModule     (BullMQ connection + queue registration)
 *   - RendererModule  (Puppeteer)
 *   - ArtifactsModule (storage + metadata)
 *   - DocumentsModule (validation)
 *   - StorageModule   (filesystem storage, @Global)
 *   - PdfProcessor    (the BullMQ consumer)
 *
 * Running the worker as a separate process means Chromium memory pressure
 * here cannot starve the API process.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { validationSchema } from '../config/validation.schema';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from './queue.module';
import { RendererModule } from '../renderer/renderer.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { DocumentsModule } from '../documents/documents.module';
import { StorageModule } from '../storage/storage.module';
import { BatchesModule } from '../batches/batches.module';
import { RecoveryModule } from '../recovery/recovery.module';
import { PdfProcessor } from './pdf.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    PrismaModule,
    QueueModule,
    StorageModule,
    RendererModule,
    ArtifactsModule,
    DocumentsModule,
    BatchesModule,
    RecoveryModule,
  ],
  providers: [PdfProcessor],
})
export class WorkerModule {}
