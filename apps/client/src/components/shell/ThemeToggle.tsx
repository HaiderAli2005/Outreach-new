"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname } from "next/navigation";
import { THEME_KEY, themed } from "@/lib/theme";

/**
 * Mounted once at the root. Applies the saved choice on themed pages (sign-in has no switch of its own, so this is
 * what carries it there) and keeps every other page in its own dark look, however it was reached.
 */
export function ThemeScope() {
  const path = usePathname() ?? "";
  useEffect(() => {
    if (themed(path) && read() === "light") document.documentElement.setAttribute("data-theme", "light");
    else if (!themed(path)) document.documentElement.removeAttribute("data-theme");
  }, [path]);
  return null;
}

/**
 * Light / dark switch for the website and the logged-in app. Dark is the default. The choice is kept on this device and applied as
 * html[data-theme] only on the themed pages (see themed), so other pages keep their own look.
 * The root layout applies a saved "light" before first paint (see THEME_BOOT), so a reload never flashes dark.
 */

type Theme = "light" | "dark";


function read(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function setAttr(theme: Theme) {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}

/**
 * Switches theme. Animated, the browser cross-fades one picture of the page into the other (View Transitions), so
 * every surface, border and gradient changes in the same frame: nothing is caught half-way, and no element runs its
 * own transition. Browsers without it, or with reduced motion, switch at once.
 */
function apply(theme: Theme, animate: boolean, render?: () => void) {
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (animate && !reduced && doc.startViewTransition) {
    doc.startViewTransition(() => {
      setAttr(theme);
      render?.();
    });
    return;
  }
  setAttr(theme);
  render?.();
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const t = read();
    setTheme(t);
    apply(t, false);
    // Pages without the switch go back to their own dark look (ThemeScope); a page that has it re-applies the choice.
    return () => document.documentElement.removeAttribute("data-theme");
  }, []);

  const next: Theme = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="ap-theme"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        // The icon swaps inside the same picture as the page, so it never changes a frame early.
        apply(next, true, () => flushSync(() => setTheme(next)));
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // Private windows can refuse storage; the switch still works for this visit.
        }
      }}
    >
      {theme === "light" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
