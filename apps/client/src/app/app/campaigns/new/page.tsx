"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button, ChipInput, Field, Notice, Switch, TextArea, TextField, ViewHead, useDebounced } from "@/components/ui/primitives";
import { Icon, type IconId } from "@/components/ui/Icon";
import { useRole, useToast } from "@/store";
import { errorMessage, useAddCampaignMutation, usePreviewCampaignMutation, useTargetingQuery } from "@/store/api";
import type { CampaignPreview, LeadSource, NewCampaignInput } from "@/lib/types";
import { n0 } from "@/lib/format";
import { ImportCampaigns } from "@/components/app/ImportCampaigns";

const SIZES = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,"];
const sizeLabel = (s: string) => {
  const [a, b] = s.split(",");
  return b ? `${n0(+a)} to ${n0(+b)}` : `${n0(+a)}+`;
};
/** Neighbouring sizes read as one range: "1 to 200" instead of three pills. */
const sizeSummary = (sizes: string[]) => {
  if (!sizes.length) return "Any size";
  const sorted = SIZES.filter((s) => sizes.includes(s));
  const runs: string[][] = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && SIZES.indexOf(last[last.length - 1]) === SIZES.indexOf(s) - 1) last.push(s);
    else runs.push([s]);
  }
  return runs
    .map((r) => {
      const lo = r[0].split(",")[0];
      const hi = r[r.length - 1].split(",")[1];
      return hi ? `${n0(+lo)} to ${n0(+hi)}` : `${n0(+lo)}+`;
    })
    .join(", ");
};
const OWNERS = ["owner", "founder", "c_suite", "partner"];
const MANAGERS = ["vp", "head", "director", "manager", "senior"];
const SENIORITY_LABEL: Record<string, string> = {
  owner: "Owner",
  founder: "Founder",
  c_suite: "C-level",
  partner: "Partner",
  vp: "VP",
  head: "Head",
  director: "Director",
  manager: "Manager",
  senior: "Senior",
};

type Reach = "owners" | "titles";

/**
 * New campaign: one more audience, searched on its own and switched on as soon as it is saved. The form is on the
 * left; on the right the same card setup shows for an audience, filled in as you type, with the people who match on
 * the free lead search. It shares the daily sending and the email sequence with the other campaigns.
 */
export default function NewCampaignPage() {
  const router = useRouter();
  const toast = useToast();
  const { canManage } = useRole();
  const { data: targeting } = useTargetingQuery();
  const [add, adding] = useAddCampaignMutation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [why, setWhy] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>(["1,10", "11,50", "51,200"]);
  const [regions, setRegions] = useState<string[]>([]);
  const [reach, setReach] = useState<Reach>("owners");
  const [titles, setTitles] = useState<string[]>([]);
  const [exact, setExact] = useState(true);
  const [seniorities, setSeniorities] = useState<string[]>(MANAGERS);
  const [source, setSource] = useState<LeadSource>("apollo");
  const [mapsCities, setMapsCities] = useState<string[]>([]);
  const [namedOnly, setNamedOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tried, setTried] = useState(false);

  const body: NewCampaignInput = useMemo(
    () => ({
      name: name.trim(),
      description: description.trim(),
      why: why.trim(),
      keywords,
      sizes,
      regions,
      titles: reach === "titles" ? titles : [],
      includeSimilarTitles: reach === "titles" ? !exact : false,
      seniorities: reach === "titles" ? seniorities : OWNERS,
      source,
      namedOnly: source === "apollo" ? false : namedOnly,
      mapsCities: source === "apollo" ? [] : mapsCities,
    }),
    [name, description, why, keywords, sizes, regions, reach, titles, exact, seniorities, source, namedOnly, mapsCities],
  );

  const taken = !!targeting?.groups.some((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase());
  const errors = {
    name: !name.trim() ? "Give the campaign a name." : taken ? "You already have a campaign with this name." : null,
    keywords: !keywords.length ? "Add at least one keyword." : null,
    regions: !regions.length ? "Add at least one location." : null,
    titles: reach === "titles" && !titles.length ? "Add at least one job title." : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (e: string | null) => (tried ? e : null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = () => {
    setTried(true);
    if (!valid) return;
    add(body)
      .unwrap()
      .then((r) => {
        toast(`${r.name} is on. Aperture starts finding people for it on its next search.`, "good");
        router.push(`/app/campaign/${encodeURIComponent(r.id)}`);
      })
      .catch((e) => toast(errorMessage(e), "bad"));
  };

  const done = [!!name.trim(), keywords.length > 0 && regions.length > 0, reach === "owners" || titles.length > 0];

  return (
    <div className="nc">
      <ViewHead
        kicker={<Link href="/app/campaigns">Campaigns</Link>}
        title="New campaign"
        sub="Tell Aperture who to find. It searches for them on its own, checks every email, and writes to them with your sequence."
        actions={
          canManage ? (
            <Button icon="upload" onClick={() => setImporting(true)}>
              Import from CSV
            </Button>
          ) : null
        }
      />
      {importing ? <ImportCampaigns onClose={() => setImporting(false)} onDone={() => router.push("/app/campaigns")} /> : null}
      {!canManage ? <Notice tone="info">Only owners and managers can add campaigns.</Notice> : null}

      <div className="nc-grid">
        <div className="nc-form">
          <Section n={1} done={done[0]} title="The campaign" sub="A name for you, and a few words the writer uses to sound like it knows this market.">
            <TextField label="Name" placeholder="Engineering offices · owners" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} error={show(errors.name)} />
            <TextArea label="Who they are" hint="Optional" rows={2} maxLength={600} placeholder="Engineering consultancies and architecture offices in Saudi Arabia" value={description} onChange={(e) => setDescription(e.target.value)} />
            <TextArea label="Why they would buy" hint="Optional" rows={2} maxLength={600} placeholder="They win most work through referrals and want a steadier flow of new projects" value={why} onChange={(e) => setWhy(e.target.value)} />
          </Section>

          <Section n={2} done={done[1]} title="Companies" sub="Where to look. A company matches if it has any one of the keywords.">
            <div className="nc-reach nc-src" role="radiogroup" aria-label="Where to find them">
              <ReachCard on={source === "apollo"} onPick={() => setSource("apollo")} icon="search" title="Lead search" text="Apollo's database of companies and people." />
              <ReachCard on={source === "maps"} onPick={() => setSource("maps")} icon="pin" title="Google Maps" text="Local businesses listed on Maps, like clinics and firms." />
              <ReachCard on={source === "both"} onPick={() => setSource("both")} icon="globe" title="Both" text="Apollo first, plus businesses Apollo doesn't have." />
            </div>
            <Field label="Industry keywords" hint={`${keywords.length} of 25 · paste a list separated by commas`} error={show(errors.keywords)}>
              <ChipInput values={keywords} onChange={setKeywords} label="Industry keywords" placeholder="+ Add keyword" max={25} />
            </Field>
            <Field label="Locations" hint="Countries, regions or cities" error={show(errors.regions)}>
              <ChipInput values={regions} onChange={setRegions} label="Locations" placeholder="+ Add location" max={25} />
            </Field>
            <Field label="Company size" hint={source === "maps" ? "Google Maps doesn't list company size, so this only applies to the lead search" : sizes.length ? "Staff at the company" : "Any size"}>
              <div className="chips">
                {SIZES.map((k) => (
                  <button key={k} type="button" className="pill-btn" aria-pressed={sizes.includes(k)} onClick={() => setSizes(toggle(sizes, k))}>
                    {sizeLabel(k)}
                  </button>
                ))}
              </div>
            </Field>
            {source !== "apollo" ? (
              <div className="nc-maps">
                <Field label="Cities to search on Google Maps" hint={mapsCities.length ? `${keywords.length * mapsCities.length || 0} searches: every keyword in every city` : "Leave empty to search the country's big cities (20 for Saudi Arabia)"}>
                  <ChipInput values={mapsCities} onChange={setMapsCities} label="Cities to search on Google Maps" placeholder="+ Add city" max={40} />
                </Field>
                <div className="nc-row">
                  <div>
                    <b>Named people only</b>
                    <span>Off: when nobody is named at a business, we write to the address its own website publishes, such as info@.</span>
                  </div>
                  <Switch checked={namedOnly} onChange={setNamedOnly} label="Named people only" />
                </div>
              </div>
            ) : null}
          </Section>

          <Section n={3} done={done[2]} title="People" sub="Who to write to at those companies.">
            <div className="nc-reach" role="radiogroup" aria-label="Who to reach">
              <ReachCard on={reach === "owners"} onPick={() => setReach("owners")} icon="briefcase" title="Owners and founders" text="Owners, founders, C-level and partners, whatever their exact title." />
              <ReachCard on={reach === "titles"} onPick={() => setReach("titles")} icon="users" title="People with these job titles" text="Managers and heads you name, such as a marketing or business development manager." />
            </div>
            {reach === "titles" ? (
              <>
                <Field label="Job titles" error={show(errors.titles)}>
                  <ChipInput values={titles} onChange={setTitles} label="Job titles" placeholder="+ Add title" max={25} />
                </Field>
                <div className="nc-row">
                  <div>
                    <b>Only these exact titles</b>
                    <span>Off: Apollo also adds titles it thinks are similar, which brings in more of the wrong people.</span>
                  </div>
                  <Switch checked={exact} onChange={setExact} label="Only these exact titles" />
                </div>
                <Field label="Seniority" hint={seniorities.length ? undefined : "Any seniority"}>
                  <div className="chips">
                    {MANAGERS.map((k) => (
                      <button key={k} type="button" className="pill-btn" aria-pressed={seniorities.includes(k)} onClick={() => setSeniorities(toggle(seniorities, k))}>
                        {SENIORITY_LABEL[k]}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            ) : null}
          </Section>
        </div>

        <aside className="nc-side" aria-label="Campaign preview">
          <Preview body={body} reach={reach} />
          <div className="nc-cta">
            <Button variant="primary" onClick={submit} loading={adding.isLoading} disabled={!canManage}>
              Create campaign
            </Button>
            <Link className="btn btn-ghost" href="/app/campaigns">
              Cancel
            </Link>
            <p>It starts as soon as people are found, and shares your daily budget with your other campaigns.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Section({ n, done, title, sub, children }: { n: number; done: boolean; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="ap-card nc-sec">
      <div className="nc-h">
        <span className={`nc-n${done ? " is-done" : ""}`} aria-hidden="true">
          {done ? <Icon id="check" /> : n}
        </span>
        <div>
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
      </div>
      <div className="nc-body">{children}</div>
    </section>
  );
}

function ReachCard({ on, onPick, icon, title, text }: { on: boolean; onPick: () => void; icon: IconId; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`nc-opt${on ? " on" : ""}`} onClick={onPick}>
      <span className="nc-opt-ic">
        <Icon id={icon} />
      </span>
      <span className="nc-opt-t">
        <b>{title}</b>
        <small>{text}</small>
      </span>
      <span className="nc-opt-dot" aria-hidden="true" />
    </button>
  );
}

/** The audience card from setup, filled in as the form changes, with the live count from the free lead search. */
function Preview({ body, reach }: { body: NewCampaignInput; reach: Reach }) {
  const [run, state] = usePreviewCampaignMutation();
  const [view, setView] = useState<CampaignPreview | null>(null);
  const search = useDebounced(JSON.stringify({ ...body, name: "", description: "", why: "" }), 700);
  useEffect(() => {
    const b = JSON.parse(search) as NewCampaignInput;
    if (!b.keywords.length || !b.regions.length || (!b.titles.length && !b.seniorities.length)) {
      setView(null);
      return;
    }
    let live = true;
    run(b)
      .unwrap()
      .then((v) => live && setView(v))
      .catch(() => live && setView({ ready: false, reason: "lookup-failed", count: null, people: [] }));
    return () => {
      live = false;
    };
  }, [search, run]);

  const counting = state.isLoading;
  const count = view?.ready ? view.count : null;
  return (
    <article className="ap-card ncp">
      <header className="ncp-head">
        <span className="ncp-ic" aria-hidden="true">
          <Icon id="megaphone" />
        </span>
        <div className="ncp-title">
          <h3 dir="auto" className={body.name ? "" : "is-empty"}>
            {body.name || "Your new campaign"}
          </h3>
          <p dir="auto">{body.description || "Who they are appears here."}</p>
        </div>
      </header>

      {body.source === "maps" ? (
        <div className="ncp-count" aria-live="polite">
          <span>Businesses are found on Google Maps once the campaign is on, a few searches at a time.</span>
        </div>
      ) : (
      <div className={`ncp-count${counting ? " is-busy" : ""}`} aria-live="polite">
        {count != null ? (
          <>
            <b>{n0(count)}</b>
            <span>people match on the lead search</span>
          </>
        ) : view?.reason === "not-connected" ? (
          <span>The count appears once lead search is connected.</span>
        ) : view?.reason === "lookup-failed" ? (
          <span>The count didn&apos;t load. It updates when you change the search.</span>
        ) : (
          <span>{counting ? "Counting…" : "Add keywords, a location and who to reach to see how many people match."}</span>
        )}
      </div>
      )}

      {body.source && body.source !== "apollo" ? (
        <section className="ncp-sec">
          <h4>
            Google Maps
            <span>{body.source === "both" ? "As well as the lead search." : "Instead of the lead search."}</span>
          </h4>
          <dl className="ncp-facts">
            <div className="wide">
              <dt>Searches</dt>
              <dd>
                {body.keywords.length ? (
                  <span>
                    “{body.keywords[0]} in {body.mapsCities?.[0] ?? (body.regions[0] && /saudi|ksa/i.test(body.regions[0]) ? "Riyadh" : (body.regions[0] ?? "…"))}”
                    {body.keywords.length > 1 || (body.mapsCities?.length ?? 0) !== 1 ? " and the rest" : ""}
                  </span>
                ) : (
                  <span className="ncp-none">Add keywords</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Cities</dt>
              <dd>{body.mapsCities?.length ? body.mapsCities.join(", ") : "The country's big cities"}</dd>
            </div>
            <div>
              <dt>Who we write to</dt>
              <dd>{body.namedOnly ? "Named people only" : "Named people, else the address on their website"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section className="ncp-sec">
        <h4>Who we&apos;ll email</h4>
        <dl className="ncp-facts">
          <div className="wide">
            <dt>{reach === "owners" ? "People" : "Job titles"}</dt>
            <dd>
              {reach === "owners" ? (
                <span>Owners, founders, C-level and partners</span>
              ) : body.titles.length ? (
                <>
                  {body.titles.map((t) => (
                    <span className="ncp-t" key={t} dir="auto">
                      {t}
                    </span>
                  ))}
                  <span className="ncp-sim">{body.includeSimilarTitles ? "and similar titles" : "exact titles only"}</span>
                </>
              ) : (
                <span className="ncp-none">No titles yet</span>
              )}
            </dd>
          </div>
          {reach === "titles" ? (
            <div>
              <dt>Seniority</dt>
              <dd>{body.seniorities.length ? body.seniorities.map((x) => SENIORITY_LABEL[x] ?? x).join(", ") : "Any"}</dd>
            </div>
          ) : null}
          <div>
            <dt>Company size</dt>
            <dd>{sizeSummary(body.sizes)}</dd>
          </div>
          <div>
            <dt>Locations</dt>
            <dd>{body.regions.join(", ") || <span className="ncp-none">None yet</span>}</dd>
          </div>
        </dl>
      </section>

      {view?.people.length ? (
        <section className="ncp-sec">
          <h4>
            Real people in this audience
            <span>Last names and emails stay hidden until they are emailed.</span>
          </h4>
          <ul className="ncp-people">
            {view.people.map((x, i) => (
              <li key={`${x.firstName}-${x.company}-${i}`}>
                <span className="ncp-av" aria-hidden="true">
                  {x.firstName.charAt(0)}
                </span>
                <span className="ncp-who">
                  <b>
                    {x.firstName} {x.lastInitial ? `${x.lastInitial}.` : ""}
                  </b>
                  <small dir="auto">{[x.title, x.company].filter(Boolean).join(" at ")}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ncp-sec">
        <h4>
          Industry keywords
          <span>We look for these words in company profiles.</span>
        </h4>
        <div className="ncp-kws">
          {body.keywords.length ? (
            body.keywords.map((k) => (
              <span className="ncp-t" key={k} dir="auto">
                {k}
              </span>
            ))
          ) : (
            <span className="ncp-none">No keywords yet</span>
          )}
        </div>
      </section>
    </article>
  );
}
