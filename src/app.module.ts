/**
 * app.module.ts
 *
 * Root NestJS module. Responsible for:
 * 1. Loading and validating environment configuration at startup.
 * 2. Importing feature modules.
 * 3. Providing global guards and filters.
 *
 * SOLID — Single Responsibility: This module composes the application.
 * Individual features live in their own modules (HealthModule, etc.).
 *
 * SOLID — Dependency Inversion: Business modules depend on ConfigModule
 * (an abstraction over environment variables), not on process.env directly.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { DocumentsModule } from './documents/documents.module';
import { RendererModule } from './renderer/renderer.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    // ── Configuration ────────────────────────────────────────────────────
    // isGlobal: true means every other module can inject ConfigService
    // without importing ConfigModule again.
    // validationSchema: Joi validates all env vars at startup.
    // load: typed configuration factory for type-safe access.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: {
        // Reject unknown env variables. Prevents silent typos like
        // DATABSE_URL (missing letter) from being ignored.
        allowUnknown: true,
        abortEarly: false,
      },
    }),

    // ── Feature Modules ──────────────────────────────────────────────────
    HealthModule,
    PrismaModule,
    DocumentsModule,
    RendererModule,
    JobsModule,
    // Future modules will be added here:
    // JobsModule, BatchesModule, StorageModule, RendererModule, DownloadsModule
  ],

  providers: [
    // ── Global Exception Filter ──────────────────────────────────────────
    // Catches all unhandled exceptions and formats them consistently.
    // Applied globally here instead of per-controller.
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },

    // ── Global Auth Guard ─────────────────────────────────────────────────
    // Every route requires an X-API-Key header.
    // Routes decorated with @Public() are exempt.
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },

    // ── Global Logging Interceptor ────────────────────────────────────────
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
