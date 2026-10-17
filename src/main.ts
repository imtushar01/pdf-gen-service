/**
 * main.ts — API process entrypoint
 *
 * Starts the NestJS HTTP server.
 * This file is intentionally minimal — configuration and wiring live in
 * AppModule and the individual feature modules.
 *
 * A separate worker.ts entrypoint (added in Milestone 7) will start the
 * BullMQ worker process. Keeping them separate means Chromium memory pressure
 * in workers cannot starve the API process.
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logging/json-logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Structured JSON logs in production, readable text in dev/test.
    logger: new JsonLogger(),
  });

  // ── Global prefix ──────────────────────────────────────────────────────
  // All routes are prefixed with /api/v1 for versioning.
  // The health endpoint lives at /health (unprefixed) for load-balancer probing.
  app.setGlobalPrefix('api/v1', {
    exclude: ['health'],
  });

  // ── Global Validation Pipe ─────────────────────────────────────────────
  // Validates and transforms incoming request bodies using class-validator.
  // whitelist: strips properties not declared in DTOs (defense against
  //            mass-assignment attacks).
  // forbidNonWhitelisted: returns 400 if unknown properties are sent.
  // transform: converts plain objects to DTO class instances so decorators work.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ── Swagger / OpenAPI ──────────────────────────────────────────────────
  // Auto-generates API documentation from decorators.
  // Available at /api/docs in development.
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('PDF Generation Service')
      .setDescription(
        'Microservice for generating individual and bulk PDF documents ' +
          '(invoices and purchase orders) for an ERP application.\n\n' +
          '**Authentication:** Send `X-API-Key: <your-key>` header with every request.\n\n' +
          '**Health check:** `GET /health` (unauthenticated).',
      )
      .setVersion('1.0.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-Key',
          in: 'header',
          description: 'Service-to-service API key. See .env.example.',
        },
        'X-API-Key',
      )
      .addTag('Health', 'Service liveness checks')
      .addTag('Jobs', 'Single document PDF generation')
      .addTag('Batches', 'Bulk PDF generation (up to 100 documents)')
      .addTag('Downloads', 'PDF and ZIP artifact downloads')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port);

  console.log(
    `PDF Generation Service running on http://localhost:${port.toString()}`,
  );
  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `Swagger documentation: http://localhost:${port.toString()}/api/docs`,
    );
  }
}

// Top-level await is intentional — startup errors should crash the process
// loudly so they are visible in container logs.
bootstrap().catch((err: unknown) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
