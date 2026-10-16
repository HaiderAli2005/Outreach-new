import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { OrgSummary, Session, SessionUser } from "@/lib/types";

export type AuthStatus = "idle" | "loading" | "authed" | "anon";

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  user: SessionUser | null;
  organizations: OrgSummary[];
  activeOrgId: string | null;
}

const ORG_KEY = "ap_org";

export function rememberedOrg(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

function rememberOrg(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ORG_KEY, id);
    else window.localStorage.removeItem(ORG_KEY);
  } catch {}
}

const initialState: AuthState = { status: "idle", token: null, user: null, organizations: [], activeOrgId: null };

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    restoring(state) {
      state.status = "loading";
    },
    sessionReceived(state, action: PayloadAction<Session>) {
      const s = action.payload;
      state.status = "authed";
      state.token = s.accessToken;
      state.user = s.user;
      state.organizations = s.organizations;
      state.activeOrgId = s.activeOrganizationId;
      rememberOrg(s.activeOrganizationId);
    },
    organizationsChanged(state, action: PayloadAction<{ organizations: OrgSummary[]; activeOrganizationId: string | null }>) {
      state.organizations = action.payload.organizations;
      state.activeOrgId = action.payload.activeOrganizationId;
      rememberOrg(action.payload.activeOrganizationId);
    },
    signedOut(state) {
      state.status = "anon";
      state.token = null;
      state.user = null;
      state.organizations = [];
      state.activeOrgId = null;
    },
  },
});

export const { restoring, sessionReceived, organizationsChanged, signedOut } = authSlice.actions;
export default authSlice.reducer;
