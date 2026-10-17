/**
 * downloads.module.ts
 *
 * Wires the downloads controller. Imports JobsModule (for job lookup) and
 * ArtifactsModule (for artifact metadata + checksum verification).
 * The STORAGE_SERVICE token is available globally from StorageModule.
 */
import { Module } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';
import { JobsModule } from '../jobs/jobs.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';

@Module({
  imports: [JobsModule, ArtifactsModule],
  controllers: [DownloadsController],
})
export class DownloadsModule {}
