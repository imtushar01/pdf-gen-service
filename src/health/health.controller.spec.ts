/**
 * health.controller.spec.ts — Unit tests for HealthController
 *
 * These tests verify the controller's logic in isolation.
 * We mock ConfigService so we don't need a real environment.
 *
 * What we test:
 * 1. Returns the correct shape and status 'ok'
 * 2. Returns a valid ISO timestamp
 * 3. Returns the environment from ConfigService
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
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
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return status ok', () => {
    const result = controller.check();
    expect(result.status).toBe('ok');
  });

  it('should return a valid ISO timestamp', () => {
    const result = controller.check();
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('should return the environment from ConfigService', () => {
    const result = controller.check();
    expect(result.environment).toBe('test');
  });

  it('should return a version string', () => {
    const result = controller.check();
    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
  });
});
