import type { ReactElement, ReactNode } from "react";
import { Provider } from "react-redux";
import { render } from "@testing-library/react";
import { makeStore } from "@/store";

export function renderWithStore(ui: ReactElement) {
  const store = makeStore();
  return { store, ...render(ui, { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> }) };
}
