import pino from "pino";
import { env, isProd, isTest } from "../config/env.js";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  base: undefined,
  messageKey: "message",
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash", "*.apiKey"],
    censor: "[redacted]",
  },
  transport: !isProd && !isTest ? { target: "pino-pretty", options: { colorize: true, messageKey: "message" } } : undefined,
});
