import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

// PrismaModule is @Global(), so PrismaService is available here
// without explicitly importing PrismaModule again.
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
