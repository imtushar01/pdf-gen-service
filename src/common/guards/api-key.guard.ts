/**
 * api-key.guard.ts
 *
 * Global authentication guard that enforces API key authentication
 * on all routes except those marked with @Public().
 *
 * The caller must send the header: X-API-Key: <your-api-key>
 *
 * Why a guard and not middleware?
 * NestJS guards have access to the ExecutionContext, which lets us read
 * route metadata (like @Public()). Middleware runs before the DI container
 * is fully available and cannot read decorator metadata.
 *
 * SOLID — Single Responsibility: This class only decides "is this request
 * allowed to proceed?" Nothing else.
 *
 * SOLID — Dependency Inversion: We depend on ConfigService (an abstraction),
 * not on process.env directly.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if this route is explicitly marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers['x-api-key'];
    const expectedKey = this.configService.get<string>('apiKey');

    if (!providedKey || !expectedKey) {
      throw new UnauthorizedException(
        'Missing X-API-Key header. See API documentation.',
      );
    }

    // Use constant-time comparison to prevent timing attacks.
    // A timing attack measures how long comparison takes — a naive string
    // comparison short-circuits on the first mismatch, leaking information
    // about how many characters were correct.
    if (!this.safeCompare(String(providedKey), expectedKey)) {
      throw new UnauthorizedException('Invalid API key.');
    }

    return true;
  }

  /**
   * Constant-time string comparison.
   * Prevents timing attacks on the API key.
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      // Still do the loop to avoid leaking length information via timing,
      // but we know the answer is false.
      let mismatch = 1;
      for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
      }
      return false;
    }
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }
}
