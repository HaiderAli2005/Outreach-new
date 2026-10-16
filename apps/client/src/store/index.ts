import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import { useDispatch, useSelector, useStore, type TypedUseSelectorHook } from "react-redux";
import { useState } from "react";
import { downloadCsv } from "@/lib/download";
import { api } from "./api";
import auth, { signedOut } from "./authSlice";
import toasts, { pushToast, type ToastTone } from "./toastSlice";
import upgrade from "./upgradeSlice";

export function makeStore() {
  const store = configureStore({
    reducer: { auth, toasts, upgrade, [api.reducerPath]: api.reducer },
    middleware: (gdm) => gdm().concat(api.middleware),
  });
  setupListeners(store.dispatch);
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export function useToast() {
  const dispatch = useAppDispatch();
  // An empty message means the error was already shown elsewhere (the upgrade prompt), so nothing is toasted.
  return (message: string, tone: ToastTone = "info") => {
    if (message) dispatch(pushToast(message, tone));
  };
}

export function useRole() {
  const { organizations, activeOrgId } = useAppSelector((s) => s.auth);
  const role = organizations.find((o) => o.id === activeOrgId)?.role ?? null;
  return { role, canManage: role === "OWNER" || role === "ADMIN" };
}

export function resetAll(dispatch: AppDispatch) {
  dispatch(signedOut());
  dispatch(api.util.resetApiState());
}

export function useExport() {
  const store = useStore() as AppStore;
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (path: string, name: string) => {
    setBusy(path);
    try {
      await downloadCsv(store, path, name);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}
