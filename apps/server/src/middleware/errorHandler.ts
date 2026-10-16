import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { isProd } from "../config/env.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` }, requestId: req.requestId });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Something went wrong";
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "Some fields are invalid";
    details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      status = 409;
      code = "CONFLICT";
      message = "That already exists";
    } else if (err.code === "P2025") {
      status = 404;
      code = "NOT_FOUND";
      message = "Resource not found";
    } else {
      code = "DATABASE_ERROR";
    }
  } else if (err?.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request body is too large";
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body is not valid JSON";
  }

  if (status >= 500) logger.error({ err, requestId: req.requestId, path: req.path }, "request failed");
  else logger.debug({ code, path: req.path }, message);

  const body: Record<string, unknown> = { error: { code, message, ...(details ? { details } : {}) }, requestId: req.requestId };
  if (!isProd && status >= 500 && err instanceof Error) (body.error as Record<string, unknown>).debug = err.message;
  res.status(status).json(body);
};
