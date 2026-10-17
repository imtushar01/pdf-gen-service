/**
 * jobs.module.ts
 *
 * Wires up the jobs feature: controller + service.
 * Imports DocumentsModule to access DocumentValidationService.
 * PrismaService is available globally (PrismaModule is @Global).
 *
 * JobsService is exported so the BatchesModule (M8) and the worker (M7)
 * can reuse the job orchestration logic.
 */
import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  imports: [DocumentsModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
