import Link from "next/link";

export default function NotFound() {
  return (
    <div className="shell-bg" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card glass" style={{ width: "min(460px, 100%)", textAlign: "center", padding: 34 }}>
        <div className="ob-kicker" style={{ justifyContent: "center" }}>
          404
        </div>
        <h1 className="ob-h sm" style={{ margin: "12px auto 0" }}>
          This page doesn&apos;t exist.
        </h1>
        <p className="ob-p" style={{ margin: "12px auto 0" }}>
          The link may be old, or the page moved.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 22 }}>
          <Link className="btn btn-primary" href="/app">
            Open the app
          </Link>
          <Link className="btn btn-ghost" href="/">
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
