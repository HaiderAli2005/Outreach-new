import type { AppStore } from "@/store";
import { API_BASE, refreshSession } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";

export async function downloadCsv(store: Pick<AppStore, "getState" | "dispatch">, path: string, fallbackName: string): Promise<void> {
  const call = () => {
    const { token, activeOrgId } = store.getState().auth;
    return fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(activeOrgId ? { "x-organization-id": activeOrgId } : {}) },
    });
  };
  let res = await call();
  if (res.status === 401) {
    const s = await refreshSession(store.getState().auth.activeOrgId);
    if (s) {
      store.dispatch(sessionReceived(s));
      res = await call();
    }
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "The export failed. Please try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
