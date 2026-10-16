/**
 * http-exception.filter.ts
 *
 * Global exception filter that normalizes all HTTP errors into a consistent
 * response shape, regardless of where in the application they originate.
 *
 * All error responses look like:
 * {
 *   "statusCode": 400,
 *   "error": "Bad Request",
 *   "message": "Validation failed",
 *   "details": [...],   // optional, present for validation errors
 *   "timestamp": "...",
 *   "path": "/api/v1/jobs"
 * }
 *
 * Why does this matter?
 * Without a global filter, NestJS returns different shapes depending on
 * the error type. The Django ERP client needs to parse a predictable
 * structure, not guess which error format it got.
 *
 * SOLID — Single Responsibility: This filter's only job is to format errors.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const body = exceptionResponse as Record<string, unknown>;
        message = (body.message as string) ?? exception.message;
        // class-validator puts an array of errors in 'message' for 400s
        if (Array.isArray(body.message)) {
          details = body.message;
          message = 'Validation failed';
        }
      } else {
        message = exception.message;
      }
    } else {
      // Unexpected error — don't leak internal details to the client
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred. Please try again later.';
      this.logger.error('Unhandled exception', exception);
    }

    const body: ErrorBody = {
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      ...(details !== undefined && { details }),
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(body);
  }
}
