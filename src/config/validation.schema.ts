/**
 * validation.schema.ts
 *
 * Joi schema that validates environment variables at application startup.
 *
 * Why Joi instead of just TypeScript types?
 * TypeScript types are compile-time only — they vanish at runtime.
 * Joi validates actual runtime values and throws a clear error if they are wrong.
 * This prevents silent misconfiguration in production.
 *
 * SOLID — Single Responsibility:
 * This file's only job is to define what valid configuration looks like.
 * It does not load, transform, or use the config.
 */
import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Required in all environments
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().integer().min(1024).max(65535).default(3000),

  // API key must be present; in test mode we allow a well-known test value
  API_KEY: Joi.string().min(16).required().messages({
    'string.min':
      'API_KEY must be at least 16 characters. Use a randomly generated value.',
    'any.required': 'API_KEY is required. See .env.example.',
  }),

  // Required because Prisma uses DATABASE_URL directly
  DATABASE_URL: Joi.string().uri().required().messages({
    'any.required': 'DATABASE_URL is required. See .env.example.',
  }),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().integer().default(6379),

  ARTIFACTS_DIR: Joi.string().default('./artifacts'),

  RENDER_CONCURRENCY: Joi.number().integer().min(1).max(16).default(4),
  RENDER_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(120000)
    .default(30000),
  RENDER_CHUNK_SIZE: Joi.number().integer().min(10).max(500).default(100),
});
