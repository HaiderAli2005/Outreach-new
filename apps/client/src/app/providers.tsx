"use client";

import { useState, type ReactNode } from "react";
import { Provider } from "react-redux";
import { makeStore } from "@/store";
import { Toaster } from "@/components/ui/overlays";
import { UpgradePrompt } from "@/components/billing/Credits";
import { ThemeScope } from "@/components/shell/ThemeToggle";

export function Providers({ children }: { children: ReactNode }) {
  const [store] = useState(makeStore);
  return (
    <Provider store={store}>
      <ThemeScope />
      {children}
      <Toaster />
      <UpgradePrompt />
    </Provider>
  );
}
