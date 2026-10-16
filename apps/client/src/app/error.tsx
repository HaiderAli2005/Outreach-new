"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="shell-bg" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card glass" style={{ width: "min(460px, 100%)", textAlign: "center", padding: 34 }}>
        <h1 className="ob-h sm" style={{ margin: "0 auto" }}>
          Something went wrong.
        </h1>
        <p className="ob-p" style={{ margin: "12px auto 0" }}>
          The page hit an unexpected error. Try again, and if it keeps happening let us know{error.digest ? ` with reference ${error.digest}` : ""}.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 22 }}>
          <button className="btn btn-primary" type="button" onClick={reset}>
            Try again
          </button>
          <a className="btn btn-ghost" href="/app">
            Open the app
          </a>
        </div>
      </div>
    </div>
  );
}
