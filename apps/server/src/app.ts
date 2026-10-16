import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { webOrigins, isTest } from "./config/env.js";
import { requestId } from "./middleware/requestId.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { apiRouter } from "./routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { unsubscribeRouter } from "./modules/unsubscribe/unsubscribe.routes.js";

// Money is bigint deci-cents. Responses format it into strings at the boundary; this is only a safety net so a raw
// ledger value can never crash a response (it is sent as an exact string, never a float).
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(requestId);
  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as express.Request).requestId ?? "",
        autoLogging: { ignore: (req) => req.url === "/healthz" },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      }),
    );
  }
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || webOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-Organization-Id", "X-Requested-With", "Idempotency-Key"],
      exposedHeaders: ["X-Request-Id", "Content-Disposition"],
    }),
  );
  app.use(cookieParser());
  app.use(
    express.json({
      limit: "5mb",
      verify: (req, _res, buf) => {
        if ((req as express.Request).originalUrl?.startsWith("/api/v1/billing/webhook")) (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));
  app.use("/api/v1/health", healthRouter);
  // Unsubscribe links live on each sending domain, whose web traffic points here: /u/<token> for any host.
  app.use("/u", unsubscribeRouter);
  app.use("/api/v1", apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
