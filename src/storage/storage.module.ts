/**
 * storage.module.ts
 *
 * Binds the STORAGE_SERVICE injection token to a concrete implementation.
 *
 * This is where the Open/Closed seam lives. To switch to S3 in production:
 *   1. Write S3StorageService implements IStorageService
 *   2. Change `useClass: FilesystemStorageService` to `useClass: S3StorageService`
 *      (or select based on config: NODE_ENV / STORAGE_BACKEND)
 *   3. Nothing else changes — every consumer injects via STORAGE_SERVICE.
 *
 * @Global() because storage is infrastructure used across the worker,
 * download controller, and batch service. Marking it global avoids
 * importing StorageModule into every feature module.
 */
import { Global, Module } from '@nestjs/common';
import { FilesystemStorageService } from './filesystem.storage';
import { STORAGE_SERVICE } from './storage.interface';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_SERVICE,
      useClass: FilesystemStorageService,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
