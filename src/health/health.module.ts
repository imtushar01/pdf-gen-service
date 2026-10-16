/**
 * health.module.ts
 *
 * NestJS module for health checking.
 * Exported so AppModule can import it cleanly.
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
