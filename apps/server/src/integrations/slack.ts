import { getCredential } from "./credentials.js";
import { logger } from "../lib/logger.js";

export type SlackPoster = (orgId: string, text: string) => Promise<boolean>;

const defaultPoster: SlackPoster = async (orgId, text) => {
  const url = await getCredential(orgId, "SLACK_WEBHOOK");
  if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return false;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch (err) {
    logger.warn({ err: (err as Error).message, orgId }, "slack post failed");
    return false;
  }
};

let poster: SlackPoster = defaultPoster;

export function postToSlack(orgId: string, text: string): Promise<boolean> {
  return poster(orgId, text).catch(() => false);
}

export function setSlackPoster(p: SlackPoster | null): void {
  poster = p ?? defaultPoster;
}
