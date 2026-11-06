"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The setup flow's "next" button. Each step places it right under its own heading. */
export const StepCtaContext = createContext<ReactNode>(null);

export function StepCta() {
  const cta = useContext(StepCtaContext);
  return cta ? <div className="step-cta">{cta}</div> : null;
}
