"use client";

import { useEffect, useState } from "react";

const RAIL_KEY = "ap-rail-collapsed";

/** Desktop only: the rail folds down to icons. Remembered per browser, shared by the app and the admin console. */
export function useRailCollapse(onToggle?: () => void) {
  const [mini, setMini] = useState(false);
  useEffect(() => {
    try {
      setMini(localStorage.getItem(RAIL_KEY) === "1");
    } catch {}
  }, []);
  const toggle = () => {
    onToggle?.();
    setMini((m) => {
      try {
        localStorage.setItem(RAIL_KEY, m ? "0" : "1");
      } catch {}
      return !m;
    });
  };
  return [mini, toggle] as const;
}

/** The sidebar-toggle glyph: a window with its left column marked off. */
function PanelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}

export function RailToggle({ mini, onClick }: { mini: boolean; onClick: () => void }) {
  const label = mini ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" className="ap-collapse" onClick={onClick} aria-label={label} aria-pressed={mini} title={label}>
      <PanelIcon />
    </button>
  );
}
