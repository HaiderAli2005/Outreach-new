"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#161615", color: "#F2EEE7", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>Aperture couldn&apos;t load.</h1>
          <p style={{ color: "#B9B1A5" }}>Please refresh the page.</p>
          <button type="button" onClick={reset} style={{ marginTop: 12, padding: "10px 18px", borderRadius: 12, border: 0, background: "#D4AE72", color: "#15100C", fontWeight: 600 }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
