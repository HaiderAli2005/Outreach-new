"use client";

import { useCallback, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useLazySiteCheckQuery } from "@/store/api";
import type { SiteCheck } from "@/lib/types";

/**
 * Checks a domain the moment it is entered, the same way the analysis reads it, so a typo or a site that can't be
 * read is caught at step 1 instead of surprising the customer at step 3.
 *
 *   ok           go on
 *   missing      stop: the message says to check the spelling
 *   unreadable   say why, and let the customer go on anyway (they answer three questions instead)
 *
 * If the check itself can't run (offline, rate limited), the customer goes on: the analysis is the final word.
 */
export function useSiteCheck() {
  const [trigger] = useLazySiteCheckQuery();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SiteCheck | null>(null);
  const run = useCallback(
    async (domain: string, fresh = false): Promise<SiteCheck | null> => {
      setBusy(true);
      try {
        const r = await trigger(domain, !fresh).unwrap();
        setResult(r);
        return r;
      } catch {
        setResult(null);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [trigger],
  );
  const clear = useCallback(() => setResult(null), []);
  return { run, busy, result, clear };
}

/** The reason a site can't be read, with the two ways forward. Only for "unreadable"; "missing" is a field error. */
export function SiteNotice({ check, onContinue, onRetry, retrying }: { check: SiteCheck; onContinue: () => void; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="site-note" role="alert">
      <Icon id="alert" />
      <div>
        <b>{check.message}</b>
        You can still continue: you&apos;ll answer three quick questions about your business instead, and we build your audience from them.
        <div className="site-note-a">
          <button type="button" className="btn btn-sm btn-primary" onClick={onContinue}>
            Continue anyway
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry} disabled={retrying}>
            {retrying ? <span className="au-spin" /> : null}
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}
