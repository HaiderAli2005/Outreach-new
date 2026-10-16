"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { useAppDispatch } from "@/store";
import { errorMessage, useLoginMutation, useProvidersQuery, useRegisterMutation } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { needsVerification, type Session, type Verification } from "@/lib/types";
import { NumberMatch } from "@/components/auth/NumberMatch";
import { AuthShell } from "@/components/auth/AuthShell";

function strength(v: string): number {
  if (!v) return 0;
  if (v.length < 8) return 1;
  if ((/[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v)) || v.length >= 14) return 3;
  return /[0-9]|[^A-Za-z0-9]/.test(v) ? 2 : 1;
}

const HINTS = ["Use 8 or more characters, with a number or symbol.", "Too short. Use at least 8 characters.", "Good. Add a symbol to make it stronger.", "Strong password."];

/** Google's "G" mark, from Google's sign-in button code. */
function GoogleMark() {
  return (
    <svg className="au-gmark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function AuthCard({
  mode,
  onMode,
  domain,
  next,
  onDone,
  changeHref = "/",
}: {
  mode: "up" | "in";
  onMode: (m: "up" | "in") => void;
  domain?: string;
  next: string;
  onDone: (s: Session) => void;
  changeHref?: string;
}) {
  const dispatch = useAppDispatch();
  const { data: providers, refetch: refetchProviders } = useProvidersQuery();
  const [login, loginState] = useLoginMutation();
  const [register, registerState] = useRegisterMutation();
  const [stage, setStage] = useState<"email" | "details">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ msg: string; field?: string } | null>(null);
  const [pending, setPending] = useState<Verification | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const up = mode === "up";
  const busy = loginState.isLoading || registerState.isLoading;
  const s = strength(password);
  const googleHref = `/api/v1/auth/oauth/google/start?next=${encodeURIComponent(next)}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`;

  useEffect(() => {
    const t = setTimeout(() => firstRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [stage, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (stage === "email") {
      const v = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return setErr({ msg: v ? "That email doesn't look right. Check it for typos." : "Enter your work email to continue.", field: "email" });
      setEmail(v);
      setStage("details");
      return;
    }
    if (up && !name.trim()) return setErr({ msg: "Enter your full name.", field: "name" });
    if (up && password.length < 8) return setErr({ msg: "Use at least 8 characters for your password.", field: "password" });
    if (!up && !password) return setErr({ msg: "Enter your password.", field: "password" });
    try {
      const result = up ? await register({ name: name.trim(), email, password, domain }).unwrap() : await login({ email, password }).unwrap();
      if (needsVerification(result)) return setPending(result.verification);
      dispatch(sessionReceived(result));
      onDone(result);
    } catch (e2) {
      setErr({ msg: errorMessage(e2) });
    }
  }

  const bad = (f: string) => (err?.field === f ? " bad" : "");

  if (pending)
    return (
      <div className="au-page">
        <AuthShell>
            <NumberMatch
              purpose="VERIFY"
              email={pending.email ?? email}
              verification={pending}
              onSession={onDone}
              onSignIn={() => (setPending(null), setPassword(""), onMode("in"), setStage("details"))}
            />
        </AuthShell>
        <p className="au-legal">Nothing is sent from your account until your email is confirmed.</p>
      </div>
    );

  return (
    <div className="au-page">
      <AuthShell>
          {domain ? (
            <div className="au-dom">
              <span className="au-fav">{domain.charAt(0).toUpperCase()}</span>
              <span className="au-dn">{domain}</span>
              <Link className="au-link" href={changeHref}>
                Change
              </Link>
            </div>
          ) : null}
          <h1 className="au-h">{up ? "Create your account" : "Welcome back"}</h1>
          <p className="au-p">
            {up ? (
              domain ? (
                <>
                  Your free analysis of <b>{domain}</b> starts the moment you&apos;re in.
                </>
              ) : (
                "Free to start. No card needed for the analysis and preview."
              )
            ) : domain ? (
              <>
                Sign in to continue with <b>{domain}</b>.
              </>
            ) : (
              "Sign in to pick up where you left off."
            )}
          </p>
          <div className="au-step" key={`${stage}-${mode}`}>
            {stage === "email" ? (
              <>
                <div className="au-oauth" style={{ gridTemplateColumns: "1fr" }}>
                  <a
                    className="au-sso au-gsi"
                    href={googleHref}
                    onClick={async (e) => {
                      if (providers?.google) return;
                      // Ask the server again rather than trusting the answer from when the page opened, so keys
                      // added since then work without a reload.
                      e.preventDefault();
                      const fresh = await refetchProviders();
                      if (fresh.data?.google) window.location.href = googleHref;
                      else setErr({ msg: "Google sign-in isn't switched on yet. Continue with your email for now." });
                    }}
                  >
                    <GoogleMark />Continue with Google
                  </a>
                </div>
                <div className="au-or">
                  <span>or continue with email</span>
                </div>
                <form className="au-form" onSubmit={submit} noValidate>
                  <div className="au-field">
                    <label htmlFor="fEmail">Work email</label>
                    <div className="au-ctl">
                      <span className="au-lead">
                        <Icon id="st-mail" />
                      </span>
                      <input
                        ref={firstRef}
                        className={`au-input${bad("email")}`}
                        id="fEmail"
                        type="email"
                        autoComplete="email"
                        placeholder={domain ? `you@${domain}` : "you@company.com"}
                        value={email}
                        onChange={(e) => (setEmail(e.target.value), setErr(null))}
                      />
                    </div>
                  </div>
                  <p className="au-err" role="alert">
                    {err?.msg ?? ""}
                  </p>
                  <button className="au-btn" type="submit">
                    Continue
                    <Icon id="arr" />
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="au-who">
                  <span className="au-lead">
                    <Icon id="st-mail" />
                  </span>
                  <span className="au-em">{email}</span>
                  <button type="button" className="au-link" onClick={() => (setStage("email"), setErr(null))}>
                    Edit
                  </button>
                </div>
                <form className="au-form" onSubmit={submit} noValidate>
                  {up ? (
                    <div className="au-field">
                      <label htmlFor="fName">Full name</label>
                      <div className="au-ctl">
                        <span className="au-lead">
                          <Icon id="st-user" />
                        </span>
                        <input ref={firstRef} className={`au-input${bad("name")}`} id="fName" autoComplete="name" placeholder="Your full name" value={name} onChange={(e) => (setName(e.target.value), setErr(null))} />
                      </div>
                    </div>
                  ) : null}
                  <div className="au-field">
                    <label htmlFor="fPass">Password</label>
                    <div className="au-ctl">
                      <span className="au-lead">
                        <Icon id="lock" />
                      </span>
                      <input
                        ref={up ? undefined : firstRef}
                        className={`au-input${bad("password")}`}
                        id="fPass"
                        type={show ? "text" : "password"}
                        autoComplete={up ? "new-password" : "current-password"}
                        placeholder={up ? "Create a password" : "Your password"}
                        value={password}
                        onChange={(e) => (setPassword(e.target.value), setErr(null))}
                      />
                      <button type="button" className="au-peek" onClick={() => setShow((x) => !x)}>
                        {show ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>
                  {!up && providers?.passwordReset ? (
                    <p className="au-hint" style={{ textAlign: "right", marginTop: -6 }}>
                      <Link className="au-link" href={`/forgot-password?email=${encodeURIComponent(email)}`}>
                        Forgot password?
                      </Link>
                    </p>
                  ) : null}
                  {up ? (
                    <>
                      <div className="au-meter" data-s={s} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </div>
                      <p className="au-hint">{HINTS[s]}</p>
                    </>
                  ) : null}
                  <p className="au-err" role="alert">
                    {err?.msg ?? ""}
                  </p>
                  <button className="au-btn" type="submit" disabled={busy}>
                    {busy ? <span className="au-spin" /> : null}
                    {busy ? (up ? "Creating your account" : "Signing in") : up ? "Create account" : "Sign in"}
                    {!busy ? <Icon id="arr" /> : null}
                  </button>
                </form>
              </>
            )}
          </div>
          <p className="au-switch">
            {up ? "Already have an account? " : "New to Aperture? "}
            <button type="button" className="au-link" onClick={() => (onMode(up ? "in" : "up"), setErr(null), setStage(email ? "details" : "email"))}>
              {up ? "Sign in" : "Create an account"}
            </button>
          </p>
      </AuthShell>
      <p className="au-legal">By continuing, you agree to Aperture&apos;s Terms of Service and Privacy Policy.</p>
    </div>
  );
}
