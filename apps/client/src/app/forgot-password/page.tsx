"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { NumberMatch } from "@/components/auth/NumberMatch";
import { NewPassword } from "@/components/auth/NewPassword";
import { FullPageLoader } from "@/components/shell/session";
import { errorMessage, useForgotPasswordMutation } from "@/store/api";
import type { Verification } from "@/lib/types";

function Forgot() {
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Verification | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [forgot, { isLoading }] = useForgotPasswordMutation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return setErr("Enter the email you signed up with.");
    setErr("");
    try {
      setPending(await forgot({ email: v }).unwrap());
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }

  if (token) return <AuthFrame><NewPassword token={token} /></AuthFrame>;

  if (pending)
    return (
      <AuthFrame legal="If there's no account for that email, no email is sent.">
        <NumberMatch purpose="RESET" email={email.trim()} verification={pending} onResetToken={setToken} onRestart={() => setPending(null)} />
      </AuthFrame>
    );

  return (
    <AuthFrame>
      <div className="au-step">
        <h1 className="au-h">Reset your password</h1>
        <p className="au-p">Enter your email. We&apos;ll show you a number here and send you an email to tap it in.</p>
        <form className="au-form" onSubmit={submit} noValidate>
          <div className="au-field">
            <label htmlFor="fpEmail">Work email</label>
            <input
              id="fpEmail"
              className={`au-input${err ? " bad" : ""}`}
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => (setEmail(e.target.value), setErr(""))}
              autoFocus
            />
          </div>
          <p className="au-err" role="alert">
            {err}
          </p>
          <button className="au-btn" type="submit" disabled={isLoading}>
            {isLoading ? <span className="au-spin" /> : null}
            Send the email
          </button>
        </form>
      </div>
    </AuthFrame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Forgot />
    </Suspense>
  );
}
