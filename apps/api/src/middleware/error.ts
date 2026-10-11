import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource does not exist.'));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred.';
  let details: unknown;

  if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'The request contains invalid fields.';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2002' || (err.code === 'P2010' && (err.meta as { code?: string } | undefined)?.code === '23505'))
  ) {
    status = 409;
    code = 'CONFLICT';
    message = 'A record with the same unique value already exists.';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'The request body is not valid JSON.';
  }

  if (status >= 500) {
    logger.error({ err, requestId: req.id }, 'Unhandled error');
  }

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      details: details ?? [],
      requestId: req.id,
      // Stack traces are never returned in production.
      ...(env.NODE_ENV !== 'production' && status >= 500 ? { debug: String(err?.message ?? err) } : {}),
    },
  });
};
