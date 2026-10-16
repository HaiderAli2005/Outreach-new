import type { Catalogue, MarketView, OnboardingState } from "@/lib/types";
import { n0 } from "@/lib/format";
import type { IconId } from "@/components/ui/Icon";
import { AUDIENCE_ICON, type RailCardData, type RailTotal } from "./Rail";
import type { RunState } from "./run";
import type { VolumeStop } from "@/lib/types";
import type { Draft } from "../SetupSteps";

/** Same hint the server sends with a streamed audience, for audiences loaded from the saved setup. */
export function audienceIcon(name: string, keywords: string[] = []): IconId {
  const t = `${name} ${keywords.join(" ")}`.toLowerCase();
  const key = /retail|shop|store|ecommerce|e-commerce|grocery|kirana/.test(t)
    ? "store"
    : /manufactur|factory|production|plant|industrial/.test(t)
      ? "factory"
      : /account|finance|tax|bookkeep|audit|bank|fintech/.test(t)
        ? "finance"
        : /wholesale|distribut|logistic|freight|import|export|trading|dealer|supply/.test(t)
          ? "logistics"
          : /agency|marketing|growth|media|advertis/.test(t)
            ? "agency"
            : /clinic|health|dental|medical|pharma|care/.test(t)
              ? "health"
              : /saas|software|engineering|tech|ai\b|product/.test(t)
                ? "tech"
                : /founder|owner|ceo|executive|leader/.test(t)
                  ? "founder"
                  : "people";
  return AUDIENCE_ICON[key];
}

const LANG: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", nl: "Dutch", it: "Italian", pt: "Portuguese", ur: "Urdu", ar: "Arabic" };

/** Everything decided so far, as rail cards. Live run data wins while the analysis is streaming. */
/** Cards for the steps that only come after the analysis: confirming the audiences, emails a day, card, start. */
const AFTER_ANALYSIS = new Set(["confirmed", "volume", "credits", "setup"]);

export function railCards(args: {
  state: OnboardingState;
  run: RunState;
  live: boolean;
  market: MarketView | undefined;
  draft: Draft | null;
  max: number;
  docked: Record<string, string>;
  setupDone: boolean;
  /** The signed-in account, shown under step 2. */
  email: string | null;
}): RailCardData[] {
  const { state, run, live, market, draft, max, docked, setupDone, email } = args;
  const o = state.onboarding;
  if (!o) return [];
  const cards: RailCardData[] = [];
  cards.push({ key: "domain", icon: "globe", title: "Your domain", detail: o.domain });
  if (email) cards.push({ key: "account", icon: "st-user", title: "Your account", detail: email });
  const bd = o.analysis?.brandDetail;
  const liveBrand = run.summaries.analyse as
    | { company?: string; oneLiner?: string; language?: string; country?: string | null; offerings?: string[]; proof?: { text: string; source: string }[]; competitors?: string[] }
    | undefined;

  const company = (live && liveBrand?.company) || o.facts.find((f) => f.key === "company")?.value || bd?.company_name || o.brand;
  const oneLiner = (live && liveBrand?.oneLiner) || o.facts.find((f) => f.key === "sell")?.value || bd?.one_liner || "";
  const country = (live && liveBrand?.country) || bd?.geographies?.[0] || null;
  const language = (live && liveBrand?.language) || bd?.language || null;
  if ((live && liveBrand) || o.analyzedAt || docked.business)
    cards.push({
      key: "business",
      icon: "building",
      title: "Your business",
      detail: oneLiner ? `${company} · ${oneLiner}` : company,
      chips: [country, language ? LANG[language] ?? language.toUpperCase() : null, live && run.pages.length ? `${run.pages.length} pages read` : null].filter((x): x is string => !!x),
      facts:
        live && liveBrand
          ? [...(liveBrand.offerings ?? []).map((x) => ({ text: `Offers ${x}`, source: "" })), ...(liveBrand.proof ?? [])]
          : o.facts.filter((f) => f.key !== "company").map((f) => ({ text: f.value, source: f.source })),
      competitors: (live && liveBrand?.competitors) || bd?.competitors || [],
      step: 1,
    });

  const audiences =
    live && run.audiences.length
      ? run.audiences.map((a) => ({ id: a.id, name: a.name, icon: AUDIENCE_ICON[a.icon] ?? ("users" as IconId), count: a.count?.total ?? null }))
      : o.groups.map((g) => ({ id: g.id, name: g.name, icon: audienceIcon(g.name, g.keywords), count: market?.groups.find((x) => x.id === g.id)?.count ?? null }));
  if (audiences.length && ((live && run.stepState.validate === "done") || o.analyzedAt || docked.buyers))
    cards.push({
      key: "buyers",
      icon: "users",
      title: "Your buyers",
      detail: `${audiences.length} audience${audiences.length === 1 ? "" : "s"}`,
      audiences,
      step: 2,
    });

  const size = run.summaries.size as { available?: boolean; reason?: string | null; people?: number | null; reachable?: number | null } | undefined;
  const liveMarket = live && size;
  const available = liveMarket ? size.available : market?.available;
  const people = liveMarket ? size.people ?? null : market?.people ?? null;
  const reach = liveMarket ? size.reachable ?? null : market?.verified ?? null;
  if (liveMarket || (o.analyzedAt && (market || docked.market)))
    cards.push({
      key: "market",
      icon: "target",
      title: "Your market",
      detail: available ? `${people != null ? n0(people) : "n/a"} match · ${reach != null ? n0(reach) : "n/a"} reachable` : (liveMarket ? size.reason : market?.reason) === "not-connected" ? "Lead search not connected yet" : "Not counted yet",
      warn: available && people != null && people < 1000 ? "A niche market. Pace your sending so it lasts." : undefined,
      step: 2,
    });

  const prospects = live && run.people.length ? run.people.length : market?.prospects.length ?? 0;
  if (prospects && (liveMarket || o.analyzedAt))
    cards.push({ key: "prospects", icon: "users", title: "Sample prospects", detail: `${n0(prospects)} ${prospects === 1 ? "person" : "people"}`, step: 2 });

  const write = run.summaries.write as { available?: boolean } | undefined;
  const emails = live && run.drafts.length ? run.drafts.length : o.preview?.length ?? 0;
  if ((live && write) || emails || docked.sequence)
    cards.push({ key: "sequence", icon: "st-mail", title: "Sample sequence", detail: emails ? `${emails} email${emails === 1 ? "" : "s"}` : "Not written yet", step: 1 });

  // The audiences are confirmed once the preview has been left for the setup.
  if (o.groups.length && (max > 2 || docked.confirmed)) {
    const on = o.groups.filter((g) => g.on).length;
    const off = o.groups.length - on;
    cards.push({ key: "confirmed", icon: "check", title: "Audiences confirmed", detail: off ? `${on} on, ${off} off` : `All ${on} on`, step: 2 });
  }

  // Later steps can't be complete while the analysis is still running or hasn't finished: a re-run, or a new
  // domain, takes the rail back to step 3 and the later cards come back once it's done.
  if (live || !o.analyzedAt) return cards.filter((c) => !AFTER_ANALYSIS.has(c.key) || (c.key === "setup" && !!o.launchedAt));
  if (draft && (max > 3 || docked.volume)) cards.push({ key: "volume", icon: "st-gauge", title: "Emails a day", detail: `${n0(draft.emails)} a day`, step: 3 });
  if (state.funded && (max > 4 || docked.credits))
    cards.push({ key: "credits", icon: "st-card", title: "Your card", detail: `Added · ${state.credits.balance} balance`, step: 4 });
  if (setupDone || docked.setup || o.launchedAt) cards.push({ key: "setup", icon: "st-send", title: "Campaign", detail: o.launchedAt ? "Live · sending today" : "Starting", step: 5 });
  return cards;
}

/** The money line under the rail. Before the card: what the chosen volume costs, priced by the server. After: the balance. */
export function runningTotal(cur: number, draft: Draft, cat: Catalogue, state: OnboardingState, stops: VolumeStop[]): RailTotal {
  if (state.funded) return { label: "Balance", value: state.credits.balance, note: `About ${n0(state.credits.emailsLeft)} emails.${state.credits.lastTopup ? "" : " Nothing has been charged."}` };
  const stop = stops.find((x) => x.emails === draft.emails);
  return {
    label: "Emails a day",
    value: n0(draft.emails),
    note: stop ? `${stop.perDay} a day at ${cat.pricing.perEmail} an email, about ${stop.perMonth} a month. Prepaid, no plan, no fees.` : `${cat.pricing.perEmail} an email, prepaid. No plan, no fees.`,
  };
}
