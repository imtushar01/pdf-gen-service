/**
 * logging.interceptor.ts
 *
 * Global interceptor that logs every incoming HTTP request and its outcome.
 *
 * Logs are structured (key=value pairs) so they can be easily parsed by
 * log aggregation tools like CloudWatch, Datadog, or a simple grep.
 *
 * Example output:
 *   [HTTP] POST /api/v1/jobs 202 45ms
 *   [HTTP] GET  /health      200 2ms
 *
 * SOLID — Single Responsibility: This interceptor only logs. It does not
 * modify the request, validate anything, or make business decisions.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, url } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const status = context
            .switchToHttp()
            .getResponse<{ statusCode: number }>().statusCode;
          const elapsed = Date.now() - start;
          this.logger.log(`${method} ${url} ${status} ${elapsed}ms`);
        },
        error: (err: unknown) => {
          const elapsed = Date.now() - start;
          const status =
            err instanceof Error &&
            'status' in err &&
            typeof (err as Record<string, unknown>).status === 'number'
              ? (err as Record<string, unknown>).status
              : 500;
          this.logger.error(`${method} ${url} ${status} ${elapsed}ms`);
        },
      }),
    );
  }
}
