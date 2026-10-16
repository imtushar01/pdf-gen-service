/**
 * api-key.guard.spec.ts — Unit tests for ApiKeyGuard
 *
 * Tests the guard logic in isolation, without starting an HTTP server.
 *
 * What we test:
 * 1. Allows public routes without an API key
 * 2. Rejects missing API key with 401
 * 3. Rejects wrong API key with 401
 * 4. Allows correct API key
 * 5. Rejects even if key length is correct but content differs
 *    (verifies constant-time comparison rejects wrong keys)
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';

function makeContext(
  headers: Record<string, string>,
  isPublic = false,
): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let reflector: Reflector;

  const VALID_KEY = 'valid-test-api-key-1234567890ab';

  beforeEach(() => {
    reflector = new Reflector();
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'apiKey') return VALID_KEY;
        return undefined;
      }),
    } as unknown as ConfigService;

    guard = new ApiKeyGuard(configService, reflector);
  });

  it('should allow requests with a correct API key', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({ 'x-api-key': VALID_KEY });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should reject requests with no API key', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should reject requests with a wrong API key', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({ 'x-api-key': 'wrong-key-wrong-key-wrong-key-w' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should reject requests with a key that has same length but wrong content', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    // Same length as VALID_KEY but all characters shifted by 1
    const almostRight = VALID_KEY.split('')
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 1))
      .join('');
    const ctx = makeContext({ 'x-api-key': almostRight });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should allow public routes without any API key', () => {
    // isPublic = true is returned by reflector for @Public() routes
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = makeContext({}); // no API key
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
