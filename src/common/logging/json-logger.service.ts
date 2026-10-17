/**
 * json-logger.service.ts
 *
 * A NestJS logger that emits structured JSON in production and readable
 * text in development.
 *
 * WHY STRUCTURED LOGS?
 * In production, logs flow to an aggregator (CloudWatch, Datadog, Loki).
 * JSON lines are machine-parseable: you can filter by level, service/context,
 * or a correlation field without brittle regex. In development, JSON is hard
 * to read, so we fall back to the default pretty format.
 *
 * Each JSON line includes:
 *   timestamp, level, context (the service name), message, and optional pid.
 *
 * SOLID — Liskov: this extends ConsoleLogger and overrides the write methods,
 * so it is a drop-in replacement wherever a NestJS LoggerService is expected.
 */
import { ConsoleLogger, LogLevel } from '@nestjs/common';

export class JsonLogger extends ConsoleLogger {
  private readonly useJson: boolean;

  constructor() {
    super();
    this.useJson = process.env.NODE_ENV === 'production';
  }

  log(message: unknown, context?: string): void {
    this.emit('log', message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.emit('error', message, context ?? stackOrContext, stackOrContext);
  }
  warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.emit('verbose', message, context);
  }

  private emit(
    level: LogLevel,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    if (!this.useJson) {
      // Delegate to the default pretty console logger in dev/test.
      switch (level) {
        case 'error':
          super.error(message as string, stack as string, context);
          break;
        case 'warn':
          super.warn(message as string, context);
          break;
        case 'debug':
          super.debug(message as string, context);
          break;
        case 'verbose':
          super.verbose(message as string, context);
          break;
        default:
          super.log(message as string, context);
      }
      return;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? 'App',
      message:
        typeof message === 'string' ? message : JSON.stringify(message),
      pid: process.pid,
    };
    if (level === 'error' && stack && stack !== context) {
      entry.stack = stack;
    }

    // One JSON object per line — the standard for log aggregators.
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
