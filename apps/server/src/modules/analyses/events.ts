import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

export const STEP_KEYS = ["fetch", "extract", "analyse", "validate", "size", "write"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export type RunEvent =
  | { type: "run.start"; analysisId: string; domain: string; steps: StepKey[] }
  | { type: "step.start"; step: StepKey; label: string }
  | { type: "step.log"; step: StepKey; text: string; state: "running" | "done" }
  | { type: "item.found"; step: StepKey; item: Record<string, unknown> }
  | { type: "step.done"; step: StepKey; summary: Record<string, unknown> }
  | { type: "run.done"; analysisId: string; outcome?: string }
  | { type: "run.error"; step: StepKey; code: string; message: string; recoverable: boolean };

/** Wakes open streams when a run writes an event. Streams also poll, so this is only a shortcut. */
export const runBus = new EventEmitter();
runBus.setMaxListeners(0);

/** Appends events to analysis_events in order. Emit never waits; flush waits for everything written. */
export class EventWriter {
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly runId: string) {}

  emit(event: RunEvent): number {
    const seq = ++this.seq;
    this.chain = this.chain
      .then(() => prisma.analysisEvent.create({ data: { analysisId: this.runId, seq, type: event.type, payload: event as unknown as Prisma.InputJsonValue } }))
      .then(() => runBus.emit(this.runId))
      .catch((err) => logger.warn({ err, runId: this.runId, seq }, "analysis event not stored"));
    return seq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}

export function sseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function sseWrite(res: Response, data: unknown, id?: number): void {
  res.write(`${id != null ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

export const HEARTBEAT_MS = 15_000;

/** Heartbeat plus close handling shared by every stream. Returns a cleanup function. */
export function keepAlive(req: Request, res: Response, onClose: () => void): () => void {
  const beat = setInterval(() => sseWrite(res, { type: "heartbeat", at: new Date().toISOString() }), HEARTBEAT_MS);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    onClose();
  };
  req.on("close", stop);
  return stop;
}
