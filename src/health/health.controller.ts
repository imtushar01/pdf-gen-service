/**
 * health.controller.ts
 *
 * Lightweight health check endpoint.
 *
 * GET /health → 200 { status: 'ok' | 'degraded', checks: {...} }
 *
 * Two types of health checks:
 * - Liveness: Is the process running? (always 200 if the server responds)
 * - Readiness: Can the service handle requests? (checks DB + Redis)
 *
 * We return 200 even when DB/Redis are down, but mark status as 'degraded'.
 * Load balancers that only care about liveness still route traffic.
 * The Django ERP can check individual component status.
 *
 * SOLID — Single Responsibility: health reporting only.
 * @Public() — unauthenticated so load balancers can probe it.
 */
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';

export interface ComponentHealth {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  version: string;
  environment: string;
  checks: {
    database: ComponentHealth;
  };
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns service liveness and component readiness. ' +
      'Always returns HTTP 200 — check the `status` field for degraded state. ' +
      'This endpoint is unauthenticated for load balancer probing.',
  })
  @ApiResponse({ status: 200, description: 'Health status' })
  async check(): Promise<HealthResponse> {
    const dbHealth = await this.checkDatabase();

    const allOk = dbHealth.status === 'ok';

    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.0.1',
      environment: this.configService.get<string>('nodeEnv') ?? 'development',
      checks: {
        database: dbHealth,
      },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Unknown database error',
      };
    }
  }
}
