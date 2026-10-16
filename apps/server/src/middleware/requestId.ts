import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id") || req.get("x-cloud-trace-context")?.split("/")[0];
  req.requestId = incoming && incoming.length < 100 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};
