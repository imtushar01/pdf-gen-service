/**
 * prisma.service.ts
 *
 * NestJS wrapper around PrismaClient.
 * Handles database connection lifecycle: connect on startup, disconnect on shutdown.
 *
 * Why a wrapper service instead of using PrismaClient directly?
 *
 * 1. Lifecycle management: NestJS modules have onModuleInit / onModuleDestroy
 *    hooks. We connect the database at startup and close the connection pool
 *    cleanly on shutdown, preventing "hanging connections" errors in tests.
 *
 * 2. Testability: Other services inject PrismaService via NestJS DI.
 *    In tests, we can replace it with a mock or a test database instance
 *    without changing the business logic code.
 *
 * 3. SOLID — Dependency Inversion: High-level services depend on this
 *    abstraction, not on PrismaClient directly.
 *
 * Usage in other services:
 *   constructor(private readonly prisma: PrismaService) {}
 *   const job = await this.prisma.job.findUnique({ where: { id } });
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        // Log slow queries in development for debugging.
        // In production, use a proper query monitoring tool.
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to database...');
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from database...');
    await this.$disconnect();
  }
}
