"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useAppDispatch } from "@/store";
import { api, errorMessage, refreshSession, useCreateOrganizationMutation } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { normDomain, validDomain } from "@/lib/format";

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

export function NoWorkspace() {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const { run, isLoading } = useCreateWorkspace();
  const router = useRouter();
  return (
    <div className="card glass" style={{ maxWidth: 560 }}>
      <h5>No workspace yet</h5>
      <h2 className="ob-h sm" style={{ marginTop: 4 }}>
        Set up your first workspace.
      </h2>
      <p className="ob-p">Enter the domain you sell from. You can also ask a teammate to invite you to theirs.</p>
      <form
        className="toolbar"
        style={{ marginTop: 18 }}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const d = normDomain(v);
          if (!validDomain(d)) return setErr("That doesn't look like a domain. Try something like northwind.io");
          setErr("");
          try {
            await run(d);
            router.push("/onboarding");
          } catch (e2) {
            setErr(errorMessage(e2));
          }
        }}
      >
        <input className="input sm grow" placeholder="yourcompany.com" value={v} onChange={(e) => setV(e.target.value)} aria-label="Company domain" aria-invalid={!!err || undefined} />
        <Button variant="primary" size="sm" type="submit" arrow loading={isLoading}>
          Create workspace
        </Button>
      </form>
      {err ? (
        <div className="banner bad" role="alert" style={{ marginTop: 12 }}>
          {err}
        </div>
      ) : null}
    </div>
  );
}
