/**
 * prisma.module.ts
 *
 * Global NestJS module for database access.
 *
 * Why @Global()?
 * The database is needed by almost every feature module (jobs, batches,
 * downloads). Marking this module global means other modules can inject
 * PrismaService without explicitly importing PrismaModule everywhere.
 * This is appropriate for infrastructure-level providers like the database
 * — it's different from feature modules which should be explicit imports.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
