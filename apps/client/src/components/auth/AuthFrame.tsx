"use client";

import type { ReactNode } from "react";
import { AuthHeader } from "./AuthHeader";
import { AuthShell } from "./AuthShell";

/** exit: false hides the header link, for pages where the user is already signed in. */
export function AuthFrame({ children, legal, exit = true }: { children: ReactNode; legal?: ReactNode; exit?: boolean }) {
  return (
    <div id="onboard" className="is-auth" style={{ minHeight: "100vh" }}>
      <AuthHeader href={exit ? "/signin" : null} label="Back to sign in" />
      <div className="au-page">
        <AuthShell>{children}</AuthShell>
        {legal ? <p className="au-legal">{legal}</p> : null}
      </div>
    </div>
  );
}
