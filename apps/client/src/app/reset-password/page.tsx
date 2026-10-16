"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { NewPassword } from "@/components/auth/NewPassword";
import { FullPageLoader } from "@/components/shell/session";
import { errorMessage, useCheckResetLinkMutation } from "@/store/api";

function Reset() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const n = params.get("n") ?? undefined;
  const [check] = useCheckResetLinkMutation();
  const [state, setState] = useState<"working" | "ready" | "failed">("working");
  const [message, setMessage] = useState("");
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setState("failed");
      setMessage("This link is missing its code. Open it again from the email.");
      return;
    }
    check({ token, n })
      .unwrap()
      .then(() => setState("ready"))
      .catch((e) => {
        const details = (e as { data?: { error?: { details?: { reason?: string; attemptsLeft?: number } } } })?.data?.error?.details;
        if (details?.reason === "wrong_number") setTriesLeft(details.attemptsLeft ?? 0);
        setState("failed");
        setMessage(errorMessage(e));
      });
  }, [token, n, check]);

  return (
    <AuthFrame>
      {state === "ready" ? (
        <NewPassword token={token} />
      ) : state === "working" ? (
        <div className="au-step">
          <h1 className="au-h">Checking your link</h1>
          <p className="nm-wait" style={{ justifyContent: "flex-start", marginTop: 16 }}>
            <span className="au-spin" />
            One moment
          </p>
        </div>
      ) : (
        <div className="au-step">
          <h1 className="au-h">{triesLeft ? "Not that number" : "That link didn't work"}</h1>
          <p className="au-p">{message}</p>
          {triesLeft ? (
            <p className="au-p">
              Go back to the email and tap the other number. {triesLeft === 1 ? "1 try left." : `${triesLeft} tries left.`}
            </p>
          ) : (
            <Link className="au-btn" href="/forgot-password" style={{ marginTop: 24 }}>
              Send a new email
            </Link>
          )}
        </div>
      )}
    </AuthFrame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Reset />
    </Suspense>
  );
}
