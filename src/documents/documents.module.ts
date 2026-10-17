/**
 * documents.module.ts
 *
 * Provides document validation to the rest of the application.
 * The JobsModule and BatchesModule will import this module to validate
 * incoming document data before creating jobs.
 */
import { Module } from '@nestjs/common';
import { DocumentValidationService } from './document-validation.service';

@Module({
  providers: [DocumentValidationService],
  exports: [DocumentValidationService],
})
export class DocumentsModule {}
