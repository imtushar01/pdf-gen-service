/**
 * artifacts.module.ts
 *
 * Provides ArtifactService to the worker (M7) and download controller (M6).
 * StorageModule is @Global, so the STORAGE_SERVICE token is available here.
 * Exported so the worker and downloads module can inject ArtifactService.
 */
import { Module } from '@nestjs/common';
import { ArtifactService } from './artifact.service';

@Module({
  providers: [ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactsModule {}
