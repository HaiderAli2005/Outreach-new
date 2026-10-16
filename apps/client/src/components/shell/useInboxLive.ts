"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { API_BASE, api, refreshSession } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { parseSse } from "@/components/onboarding/live/run";
import { useAppDispatch, useAppSelector, useToast } from "@/store";

type InboxEvent = { type: "ready" | "heartbeat" } | { type: "inbox"; replies: number; latest: { contactId: string; name: string; company: string | null; intent: string | null } | null };

/**
 * Keeps the app in step with the inbox as replies are read: one stream per signed-in tab (GET /inbox/stream). On each
 * "inbox" signal the inbox, its counts, open threads and the cockpit refetch at once, and a short toast says who
 * wrote. The nav counts refetching is also what fires the desktop notification (useReplyNotifications).
 *
 * The stream is only a signal; the pages' own timers stay as the fallback, so a dropped stream degrades to the old
 * refresh, never to stale data. It reconnects with backoff and pauses while the tab is hidden.
 */
export function useInboxLive(enabled: boolean) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const token = useAppSelector((s) => s.auth.token);
  const orgId = useAppSelector((s) => s.auth.activeOrgId);
  const path = usePathname();
  const auth = useRef({ token, orgId });
  auth.current = { token, orgId };
  const onInbox = useRef(path.startsWith("/app/inbox"));
  onInbox.current = path.startsWith("/app/inbox");
  const say = useRef(toast);
  say.current = toast;

  useEffect(() => {
    if (!enabled || !orgId) return;
    const stop = new AbortController();
    let attempt = 0;
    let unseen = 0;
    const baseTitle = document.title.replace(/^\(\d+\) New repl(y|ies) · /, "");
    const clearTitle = () => {
      if (document.visibilityState !== "visible" || !unseen) return;
      unseen = 0;
      document.title = baseTitle;
    };
    document.addEventListener("visibilitychange", clearTitle);
    stop.signal.addEventListener("abort", () => {
      document.removeEventListener("visibilitychange", clearTitle);
      if (unseen) document.title = baseTitle;
    });

    const headers = (): HeadersInit => ({
      accept: "text/event-stream",
      ...(auth.current.token ? { authorization: `Bearer ${auth.current.token}` } : {}),
      ...(auth.current.orgId ? { "x-organization-id": auth.current.orgId } : {}),
    });

    const handle = (e: InboxEvent) => {
      if (e.type !== "inbox") return;
      dispatch(api.util.invalidateTags(["Inbox", "Thread", "Nav", "Cockpit", "Contacts"]));
      if (!e.latest) return;
      // Every page says who wrote, the inbox included; only the conversation already open on screen stays quiet.
      const openThread = onInbox.current ? new URLSearchParams(window.location.search).get("c") : null;
      if (openThread !== e.latest.contactId) {
        const who = e.latest.company ? `${e.latest.name} at ${e.latest.company}` : e.latest.name;
        say.current(e.replies > 1 ? `${e.replies} new replies, latest from ${who}` : `New reply from ${who}`, "info");
      }
      // A tab in the background shows the count in its title until the customer comes back to it.
      if (document.visibilityState !== "visible") {
        unseen += e.replies;
        document.title = `(${unseen}) New ${unseen === 1 ? "reply" : "replies"} · ${baseTitle}`;
      }
    };

    const open = async (): Promise<void> => {
      const url = `${API_BASE}/inbox/stream`;
      let res = await fetch(url, { headers: headers(), credentials: "include", signal: stop.signal, cache: "no-store" });
      if (res.status === 401) {
        const session = await refreshSession(auth.current.orgId);
        if (!session) throw Object.assign(new Error("signed out"), { status: 401 });
        dispatch(sessionReceived(session));
        auth.current = { token: session.accessToken, orgId: auth.current.orgId };
        res = await fetch(url, { headers: headers(), credentials: "include", signal: stop.signal, cache: "no-store" });
      }
      if (!res.ok || !res.body) throw Object.assign(new Error(`inbox stream ${res.status}`), { status: res.status });
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events as unknown as InboxEvent[]) handle(e);
      }
    };

    const waitVisible = () =>
      document.visibilityState === "visible"
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const on = () => {
              if (document.visibilityState !== "visible") return;
              document.removeEventListener("visibilitychange", on);
              // Whatever arrived while the tab was hidden is fetched now, not when the next signal comes.
              dispatch(api.util.invalidateTags(["Inbox", "Nav", "Cockpit"]));
              resolve();
            };
            document.addEventListener("visibilitychange", on);
            stop.signal.addEventListener("abort", () => resolve(), { once: true });
          });

    const loop = async () => {
      while (!stop.signal.aborted) {
        await waitVisible();
        if (stop.signal.aborted) return;
        try {
          await open();
        } catch (err) {
          if (stop.signal.aborted) return;
          const status = (err as { status?: number }).status;
          // Signed out, or no access to this workspace: the session code takes over, nothing to retry.
          if (status === 401 || status === 403) return;
        }
        if (stop.signal.aborted) return;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5)));
      }
    };
    void loop();
    return () => stop.abort();
  }, [enabled, orgId, dispatch]);
}
