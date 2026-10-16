"use client";

import { useState } from "react";
import Link from "next/link";
import { errorMessage, useResetPasswordMutation } from "@/store/api";

export function NewPassword({ token }: { token: string }) {
  const [reset, { isLoading }] = useResetPasswordMutation();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setErr("Use at least 8 characters.");
    setErr("");
    try {
      await reset({ token, password }).unwrap();
      setDone(true);
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }

  if (done)
    return (
      <div className="au-step">
        <h1 className="au-h">Password changed</h1>
        <p className="au-p">Use your new password to sign in. Any other devices that were signed in have been signed out.</p>
        <Link className="au-btn" href="/signin" style={{ marginTop: 24 }}>
          Sign in
        </Link>
      </div>
    );

  return (
    <div className="au-step">
      <h1 className="au-h">Choose a new password</h1>
      <p className="au-p">Your current password keeps working until you save this one.</p>
      <form className="au-form" onSubmit={submit} noValidate>
        <div className="au-field">
          <label htmlFor="npPass">New password</label>
          <div className="au-pw">
            <input
              id="npPass"
              className={`au-input${err ? " bad" : ""}`}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => (setPassword(e.target.value), setErr(""))}
              autoFocus
            />
            <button type="button" className="au-peek" onClick={() => setShow((x) => !x)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <p className="au-err" role="alert">
          {err}
        </p>
        <button className="au-btn" type="submit" disabled={isLoading}>
          {isLoading ? <span className="au-spin" /> : null}
          Save new password
        </button>
      </form>
    </div>
  );
}
