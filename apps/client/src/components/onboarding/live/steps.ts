import type { IconId } from "@/components/ui/Icon";

/**
 * The seven setup steps, in order. The top bar and the rail both read this list, so the numbers always match.
 * `keys` are the rail cards filed under the step; `closes` is the card that completes it.
 */
export const SETUP_STEPS: { label: string; icon: IconId; keys: string[]; closes: string }[] = [
  { label: "Domain", icon: "globe", keys: ["domain"], closes: "domain" },
  { label: "Sign up", icon: "st-user", keys: ["account"], closes: "account" },
  { label: "Analysis", icon: "st-scan", keys: ["business", "buyers", "sequence"], closes: "sequence" },
  { label: "Free overview", icon: "st-mail", keys: ["market", "prospects", "confirmed"], closes: "confirmed" },
  { label: "Emails per day", icon: "st-gauge", keys: ["volume"], closes: "volume" },
  { label: "Add your card", icon: "st-card", keys: ["credits"], closes: "credits" },
  { label: "Campaign start", icon: "st-send", keys: ["setup"], closes: "setup" },
];
