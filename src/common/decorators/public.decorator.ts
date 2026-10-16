/**
 * public.decorator.ts
 *
 * A metadata decorator that marks a route as publicly accessible,
 * bypassing the API key guard.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   check() { ... }
 *
 * Why a decorator instead of hardcoding route names in the guard?
 * SOLID — Open/Closed: adding a new public route doesn't require modifying
 * the guard logic. We simply decorate the route. The guard is closed for
 * modification but open for extension via metadata.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a controller or route handler as publicly accessible.
 * The ApiKeyGuard checks for this metadata and skips authentication.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
