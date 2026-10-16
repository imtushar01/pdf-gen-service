/**
 * health.controller.spec.ts — Unit tests for HealthController
 *
 * We mock both ConfigService and PrismaService so no real database
 * connection is required for unit tests.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaOk = {
  $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
};

const mockPrismaDown = {
  $queryRaw: jest.fn().mockRejectedValue(new Error('Connection refused')),
};

async function makeController(prismaOverride = mockPrismaOk) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            if (key === 'nodeEnv') return 'test';
            return undefined;
          }),
        },
      },
      {
        provide: PrismaService,
        useValue: prismaOverride,
      },
    ],
  }).compile();

  return module.get<HealthController>(HealthController);
}

describe('HealthController', () => {
  it('should be defined', async () => {
    const controller = await makeController();
    expect(controller).toBeDefined();
  });

  it('should return status ok when DB is healthy', async () => {
    const controller = await makeController(mockPrismaOk);
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(result.checks.database.status).toBe('ok');
  });

  it('should return status degraded when DB is down', async () => {
    const controller = await makeController(mockPrismaDown);
    const result = await controller.check();
    expect(result.status).toBe('degraded');
    expect(result.checks.database.status).toBe('error');
    expect(result.checks.database.error).toBeDefined();
  });

  it('should return a valid ISO timestamp', async () => {
    const controller = await makeController();
    const result = await controller.check();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('should return the environment from ConfigService', async () => {
    const controller = await makeController();
    const result = await controller.check();
    expect(result.environment).toBe('test');
  });

  it('should include DB latency when healthy', async () => {
    const controller = await makeController(mockPrismaOk);
    const result = await controller.check();
    expect(typeof result.checks.database.latencyMs).toBe('number');
  });
});
