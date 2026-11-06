"use client";

import { useAppDispatch } from "@/store";
import { api, refreshSession, useCreateOrganizationMutation } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";

/** Creates a workspace for a domain and switches the session to it (setup's domain step, and "Add a workspace"). */
export function useCreateWorkspace() {
  const [create, { isLoading }] = useCreateOrganizationMutation();
  const dispatch = useAppDispatch();
  const run = async (domain: string) => {
    const org = await create({ domain }).unwrap();
    const s = await refreshSession(org.id);
    if (s) {
      dispatch(sessionReceived(s));
      dispatch(api.util.resetApiState());
    }
    return org;
  };
  return { run, isLoading };
}
