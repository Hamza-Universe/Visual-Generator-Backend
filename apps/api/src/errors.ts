import type { FastifyInstance, FastifyReply } from 'fastify';
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details: unknown[] = [],
  ) {
    super(message);
  }
}
export const sendError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof AppError)
    return reply
      .code(error.statusCode)
      .send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
  reply.log.error({ err: error }, 'Unhandled API error');
  return reply
    .code(500)
    .send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    });
};
export const registerErrorHandler = (app: FastifyInstance) =>
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return sendError(reply, error);
    const fastifyError = error as {
      code?: unknown;
      validation?: unknown;
    };
    if (fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return sendError(
        reply,
        new AppError('BAD_INPUT', 'Request body must be valid JSON', 400),
      );
    }
    if (Array.isArray(fastifyError.validation)) {
      return sendError(
        reply,
        new AppError(
          'BAD_INPUT',
          'Request validation failed',
          400,
          fastifyError.validation,
        ),
      );
    }
    return sendError(reply, error);
  });
