/**
 * health.controller.ts
 *
 * Lightweight health check endpoint.
 *
 * GET /health → 200 { status: 'ok', timestamp: '...' }
 *
 * Why a dedicated controller?
 * SOLID — Single Responsibility: health reporting is not the same concern as
 * PDF job management. Keeping it separate means it can be deployed, tested,
 * and load-balanced independently.
 *
 * The /health route is explicitly excluded from API key authentication
 * so that load balancers and container orchestrators can probe it without
 * needing credentials. This is documented in the security notes.
 */
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  version: string;
  environment: string;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns service liveness. Does not check database or queue connectivity. ' +
      'This endpoint is unauthenticated so load balancers can probe it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is running',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', example: '2026-10-17T08:00:00.000Z' },
        version: { type: 'string', example: '1.0.0' },
        environment: { type: 'string', example: 'development' },
      },
    },
  })
  check(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.0.1',
      environment: this.configService.get<string>('nodeEnv') ?? 'development',
    };
  }
}
