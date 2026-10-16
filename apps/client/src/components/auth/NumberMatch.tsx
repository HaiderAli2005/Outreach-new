"use client";

import { useEffect, useRef, useState } from "react";
import { useAppDispatch } from "@/store";
import { sessionReceived } from "@/store/authSlice";
import {
  errorCode,
  errorMessage,
  useChallengeCodeMutation,
  useChallengeSendCodeMutation,
  useChallengeStatusQuery,
  useClaimSessionMutation,
  useResendVerificationMutation,
} from "@/store/api";
import type { Session, Verification } from "@/lib/types";

const DEAD: Record<string, string> = {
  FAILED: "Too many wrong tries. Send yourself a new email to start again.",
  EXPIRED: "That email has expired. Send yourself a new one.",
};

export function NumberMatch({
  purpose,
  email,
  verification,
  onSession,
  onResetToken,
  onRestart,
  onSignIn,
}: {
  purpose: "VERIFY" | "RESET";
  email: string;
  verification: Verification;
  onSession?: (s: Session) => void;
  onResetToken?: (token: string) => void;
  onRestart?: () => void;
  onSignIn?: () => void;
}) {
  const dispatch = useAppDispatch();
  const [v, setV] = useState(verification);
  const [codeWay, setCodeWay] = useState(verification.codeSent);
  const [code, setCode] = useState("");
  const [note, setNote] = useState(verification.codeSent ? "We emailed you a 6-digit code." : "");
  const [err, setErr] = useState("");
  const [approvedElsewhere, setApprovedElsewhere] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const claiming = useRef(false);

  const [claim] = useClaimSessionMutation();
  const [sendCode, sendState] = useChallengeSendCodeMutation();
  const [answer, answerState] = useChallengeCodeMutation();
  const [resend, resendState] = useResendVerificationMutation();

  const finished = approvedElsewhere || needSignIn;
  const { data: state } = useChallengeStatusQuery(v.challengeId ?? "", {
    skip: !v.challengeId || finished,
    pollingInterval: 3000,
    refetchOnFocus: true,
  });
  const status = state?.status ?? "PENDING";

  useEffect(() => {
    if (status !== "APPROVED" || claiming.current) return;
    if (purpose === "RESET") {
      setApprovedElsewhere(true);
      return;
    }
    claiming.current = true;
    claim()
      .unwrap()
      .then((r) => {
        if (r.claimed) {
          dispatch(sessionReceived(r.session));
          onSession?.(r.session);
        } else setNeedSignIn(true);
      })
      .catch(() => setNeedSignIn(true));
  }, [status, purpose, claim, dispatch, onSession]);

  async function askForCode() {
    if (!v.challengeId) return;
    setErr("");
    try {
      await sendCode(v.challengeId).unwrap();
      setNote("Code sent. Check your email.");
      setCodeWay(true);
    } catch (e) {
      if (errorCode(e) === "RATE_LIMITED") {
        setCodeWay(true);
        setNote(errorMessage(e));
      } else setErr(errorMessage(e));
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!v.challengeId) return;
    const c = code.replace(/\D/g, "");
    if (c.length !== 6) return setErr("Enter the 6 digits from the email.");
    setErr("");
    try {
      const r = await answer({ challengeId: v.challengeId, code: c }).unwrap();
      if (r.purpose === "RESET") return onResetToken?.(r.token);
      claiming.current = true;
      dispatch(sessionReceived(r.session));
      onSession?.(r.session);
    } catch (e2) {
      setErr(errorMessage(e2));
      setCode("");
    }
  }

  async function newEmail() {
    setErr("");
    if (purpose === "RESET") return onRestart?.();
    try {
      const r = await resend().unwrap();
      if (r.verified) {
        const c = await claim().unwrap();
        if (c.claimed) {
          dispatch(sessionReceived(c.session));
          return onSession?.(c.session);
        }
        return setNeedSignIn(true);
      }
      setV({ challengeId: r.challengeId, matchNumber: r.matchNumber, codeSent: r.codeSent });
      setCodeWay(r.codeSent);
      setCode("");
      setNote(r.codeSent ? "We emailed you a 6-digit code." : "A new email is on its way.");
    } catch (e) {
      if (errorCode(e) === "CLAIM_MISSING") return setNeedSignIn(true);
      setErr(errorMessage(e));
    }
  }

  const dead = v.challengeId ? DEAD[status] : null;
  const verifying = purpose === "VERIFY";

  if (needSignIn)
    return (
      <div className="au-step nm au-status">
        <h1 className="au-h">Email confirmed</h1>
        <p className="au-p">Your email is confirmed. Sign in to carry on.</p>
        <button type="button" className="au-btn" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    );

  if (approvedElsewhere)
    return (
      <div className="au-step nm">
        <h1 className="au-h">Number matched</h1>
        <p className="au-p">Choose your new password on the device where you tapped the number. You can close this page.</p>
      </div>
    );

  return (
    <div className="au-step nm">
      <h1 className="au-h">Check your email</h1>
      {!v.challengeId ? (
        <p className="au-p">
          We couldn&apos;t send the email to <b>{email}</b>. Try sending it again.
        </p>
      ) : dead ? (
        <p className="au-p">{dead}</p>
      ) : v.matchNumber != null && !codeWay ? (
        <>
          <p className="au-p">
            We sent an email to <b>{email}</b>. Open it and tap this number:
          </p>
          <div className="nm-num" aria-label={`Your number is ${v.matchNumber}`}>
            {v.matchNumber}
          </div>
          <p className="nm-wait">
            <span className="au-spin" />
            {verifying ? "Waiting for you to tap it. This page carries on by itself." : "Waiting for you to tap it."}
          </p>
        </>
      ) : (
        <p className="au-p">
          Enter the 6-digit code we emailed to <b>{email}</b>.
        </p>
      )}

      {v.challengeId && !dead && codeWay ? (
        <form className="au-form" onSubmit={submitCode} noValidate>
          <div className="au-field">
            <label htmlFor="nmCode">6-digit code</label>
            <input
              id="nmCode"
              className={`au-input nm-code${err ? " bad" : ""}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="000000"
              value={code}
              onChange={(e) => (setCode(e.target.value), setErr(""))}
              autoFocus
            />
          </div>
          {note ? <p className="au-hint">{note}</p> : null}
          <p className="au-err" role="alert">
            {err}
          </p>
          <button className="au-btn" type="submit" disabled={answerState.isLoading}>
            {answerState.isLoading ? <span className="au-spin" /> : null}
            {verifying ? "Confirm email" : "Continue"}
          </button>
        </form>
      ) : (
        <p className="au-err" role="alert" style={{ marginTop: 14 }}>
          {err}
        </p>
      )}

      <div className="nm-actions">
        {v.challengeId && !dead && !codeWay ? (
          <button type="button" className="au-link" onClick={askForCode} disabled={sendState.isLoading}>
            {sendState.isLoading ? "Sending a code" : "Try another way"}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="au-link" onClick={newEmail} disabled={resendState.isLoading}>
          {resendState.isLoading ? "Sending" : "Send a new email"}
        </button>
      </div>
    </div>
  );
}
