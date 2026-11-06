"use client";

import { useEffect, useRef } from "react";
import { useAppDispatch } from "@/store";
import { api, useNavCountsQuery } from "@/store/api";

/**
 * One balance everywhere. A page that loads the balance (Cockpit, Credits) compares it with the wallet in the top bar;
 * when they differ, one of them is older, so both read it again. Each disagreement is acted on once, so two answers
 * that keep differing (a payment landing between the reads) can never loop.
 */
export function useBalanceSync(balance: string | null | undefined) {
  const dispatch = useAppDispatch();
  const { data } = useNavCountsQuery(undefined, { skip: !balance });
  const handled = useRef<string | null>(null);
  const wallet = data?.balance;
  useEffect(() => {
    if (!balance || !wallet || balance === wallet) return;
    const pair = `${balance}|${wallet}`;
    if (handled.current === pair) return;
    handled.current = pair;
    dispatch(api.util.invalidateTags(["Nav", "Credits", "Cockpit"]));
  }, [balance, wallet, dispatch]);
}
