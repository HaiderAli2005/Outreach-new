"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/primitives";
import { DomainSearch } from "./DomainSearch";
import { useLiquidGlass, useLiquidGlassAll } from "@/components/ui/liquidGlass";
import { usePlansQuery } from "@/store/api";
import { useSessionBootstrap } from "@/components/shell/session";
import { n0 } from "@/lib/format";

const EXAMPLE_FEED = [
  { n: "Maya Reid", r: "Loomwork", m: "This is timely. Are you free Thursday at 3?", t: "Meeting booked", c: "g", av: "#8A6A45" },
  { n: "Daniel Kerr", r: "Brightlabs", m: "Send over pricing and a short case study?", t: "Interested", c: "b", av: "#6B5B4A" },
  { n: "Priya Shah", r: "Parcelry", m: "Loop in Tom, he owns this on our side.", t: "Referral", c: "v", av: "#A07F55" },
  { n: "Chris Bell", r: "Harbor & Co", m: "Not this quarter. Try me again in January.", t: "Later", c: "y", av: "#5E5850" },
  { n: "Sofia Lund", r: "Fernway", m: "Yes, let's talk. Here's my calendar link.", t: "Meeting booked", c: "g", av: "#6E7F63" },
];

/** Every card on the home page that wears the same glass as the navbar. Their look is in landing.css. */
const GLASS_CARDS = ".console, .lp-facts-in, .lp-step, .lp-cell, .lp-point, .orbit-card, .price-card, .lp-incl, .lp-help, .cta";

function Nav() {
  const bar = useRef<HTMLDivElement>(null);
  useLiquidGlass(bar, { scale: 24, bezel: 20 });
  // Someone already signed in has nothing to sign in to or set up: they get one way back into the app.
  const session = useSessionBootstrap();
  return (
    <header className="nav">
      <div className="nav-in glass lg" ref={bar}>
        <a className="logo" href="#top" aria-label="Aperture home">
          <Mark />
          Aperture
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#product">Product</a>
          <a href="#deliverability">Deliverability</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-cta" aria-busy={session === "idle" || session === "loading"}>
          {session === "authed" ? (
            <Link className="btn btn-sm nav-open" href="/app">
              Open app
              <Icon id="arr" />
            </Link>
          ) : session === "anon" ? (
            <>
              <Link className="btn btn-text btn-sm" href="/signin">
                Sign in
              </Link>
              <Link className="btn btn-glass btn-sm" href="/onboarding">
                Start setup
              </Link>
            </>
          ) : (
            // Holds the buttons' place while the session is checked, so neither set flashes in and is swapped out.
            <span className="nav-cta-wait" />
          )}
        </div>
      </div>
    </header>
  );
}

/** The email the hero card writes, a few letters at a time. The middle part is the line written for this person. */
const MAIL = [
  "Hi Maya, saw Loomwork is opening ",
  "the EU this spring",
  " and hiring two growth roles for it. We help teams like yours book the first meetings in a new market, without touching your main domain. Worth a quick look?",
];
const MAIL_LEN = MAIL.join("").length;

function useTyping(on: boolean) {
  const [n, setN] = useState(on ? 0 : MAIL_LEN);
  useEffect(() => {
    if (!on) return;
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      i = i >= MAIL_LEN ? 0 : i + 1;
      setN(i);
      const inLine = i > MAIL[0].length && i <= MAIL[0].length + MAIL[1].length;
      t = setTimeout(step, i >= MAIL_LEN ? 3400 : inLine ? 60 : 24);
    };
    t = setTimeout(step, 600);
    return () => clearTimeout(t);
  }, [on]);
  return n;
}

function Console({ domain }: { domain: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [feedI, setFeedI] = useState(0);
  const [sent, setSent] = useState(312);
  const [motion, setMotion] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [placed, setPlaced] = useState(0);
  const base = domain.split(".")[0];
  const tld = domain.slice(base.length);
  const doms = [`get${base}.com`, `try${base}${tld}`, `${base}hq.com`, `use${base}.co`];
  const typed = useTyping(motion);
  const replies = 13 + (feedI % 3);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlaced(96.8);
      return;
    }
    setMotion(true);
    const g = setTimeout(() => setPlaced(96.8), 300);
    const a = setInterval(() => setFeedI((i) => (i + EXAMPLE_FEED.length - 1) % EXAMPLE_FEED.length), 3600);
    const b = setInterval(() => setSent((s) => (s >= 480 ? 280 : Math.min(480, s + 1 + Math.floor(Math.random() * 3)))), 1400);
    const con = ref.current;
    let ticking = false;
    const upd = () => {
      ticking = false;
      if (!con) return;
      const r = con.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (innerHeight - r.top) / (innerHeight * 0.75)));
      con.style.transform = `rotateX(${(1 - p) * 16}deg) scale(${0.94 + 0.06 * p})`;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(upd);
      }
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", upd);
    upd();
    return () => {
      clearTimeout(g);
      clearInterval(a);
      clearInterval(b);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", upd);
    };
  }, []);

  // The gold lines from each sending domain into the email, and from the email to the inbox. Drawn from where the
  // boxes are, so they follow any screen size.
  useEffect(() => {
    const g = grid.current;
    if (!g) return;
    const draw = () => {
      // Layout positions, not screen positions, so the card's tilt while scrolling doesn't bend the lines.
      const box = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return null;
        let x = 0;
        let y = 0;
        for (let n: HTMLElement | null = el; n && n !== g; n = n.offsetParent as HTMLElement | null) {
          x += n.offsetLeft;
          y += n.offsetTop;
        }
        return { x, y, w: el.offsetWidth, h: el.offsetHeight };
      };
      const mail = box(g.querySelector(".fl-mail"));
      const land = box(g.querySelector(".fl-land"));
      const from = [...g.querySelectorAll(".fl-dom")].map(box);
      if (!mail || !land || getComputedStyle(g).gridTemplateColumns.split(" ").length < 3) return setLines([]);
      const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${x1 + 22} ${y1},${x2 - 22} ${y2},${x2} ${y2}`;
      const out = from.map((d, i) => (d ? curve(d.x + d.w, d.y + d.h / 2, mail.x, mail.y + 46 + i * 24) : "")).filter(Boolean);
      out.push(curve(mail.x + mail.w, mail.y + mail.h / 2, land.x, land.y + 44));
      setLines(out);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(g);
    draw();
    return () => ro.disconnect();
  }, []);

  let left = typed;
  const parts = MAIL.map((m) => {
    const piece = m.slice(0, Math.max(0, left));
    left -= m.length;
    return piece;
  });
  const reply = [0, 1].map((k) => EXAMPLE_FEED[(feedI + k) % EXAMPLE_FEED.length]);

  return (
    <div className="stage">
      <div className="console glass fl" ref={ref} aria-label="Example of Aperture writing and sending for your domain">
        <div className="c-top">
          <div className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="c-title">
            Live outbound · <b>{domain}</b>
          </div>
          <span className="live">
            <span className="pulse" />
            Warm · day 18
          </span>
        </div>
        <div className="fl-grid" ref={grid}>
          <svg className="fl-ln" aria-hidden="true">
            {lines.map((d, i) => (
              <g key={i}>
                <path d={d} />
                {motion ? (
                  <circle r="2.6">
                    <animateMotion dur={`${1.6 + i * 0.35}s`} begin={`${i * 0.4}s`} repeatCount="indefinite" path={d} />
                  </circle>
                ) : null}
              </g>
            ))}
          </svg>
          <div className="fl-from">
            <p className="fl-lb">Sending from</p>
            {doms.map((x) => {
              const at = x.indexOf(base);
              return (
                <div className="fl-dom" key={x}>
                  <i aria-hidden="true" />
                  <span>
                    {x.slice(0, at)}
                    <em>{base}</em>
                    {x.slice(at + base.length)}
                  </span>
                </div>
              );
            })}
            <div className="fl-main">
              <Icon id="shield" /> {domain} never sends a cold email
            </div>
          </div>
          <div className="fl-mail">
            <div className="fl-mh">
              <span>Writing now · step 1 of 3</span>
              <span>sends 9:42</span>
            </div>
            <p className="fl-to">
              To <b>Maya Reid</b> · Head of Growth, Loomwork
            </p>
            <p className="fl-sj">Loomwork&apos;s new EU launch</p>
            <p className="fl-bd">
              {parts[0]}
              {parts[1] ? <mark>{parts[1]}</mark> : null}
              {parts[2]}
              {motion ? <span className="fl-cr" aria-hidden="true" /> : null}
            </p>
            <div className="fl-ft">
              <span>from {doms[1]}</span>
              <span>inbox 7 of 12</span>
            </div>
          </div>
          <div className="fl-land">
            <p className="fl-lb">Landing</p>
            <div className="fl-ga">
              <svg viewBox="0 0 46 46" aria-hidden="true">
                <circle cx="23" cy="23" r="19" className="fl-ga-bg" />
                <circle cx="23" cy="23" r="19" className="fl-ga-on" style={{ strokeDashoffset: 119.4 * (1 - placed / 100) }} />
              </svg>
              <div>
                <small>Primary inbox</small>
                <b className="num">96.8%</b>
              </div>
            </div>
            {reply.map((f, k) => (
              <div className={`fl-rp${k === 0 ? " fl-new" : ""}`} key={`${feedI}-${k}`}>
                <span className="av" style={{ background: f.av }}>
                  {f.n
                    .split(" ")
                    .map((x) => x[0])
                    .join("")}
                </span>
                <div>
                  <b>{f.n}</b>
                  <p>{f.m}</p>
                  <span className={`chip-s ${f.c}`}>{f.t}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="fl-bt">
          <div>
            Sent today<b className="num">{sent} / 480</b>
          </div>
          <div>
            Inboxes<b className="num">12 of 12</b>
          </div>
          <div>
            Replies<b className="num">{replies}</b>
          </div>
          <div>
            Meetings<b className="num">{2 + (feedI % 2)}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Scroll motion for everything below the hero.
 * [data-reveal] fades up once when it enters the viewport (stagger via --rd).
 * [data-parallax="0.08"] drifts against the scroll, measured from its parent so its own transform never feeds back.
 * Nothing moves under prefers-reduced-motion, and without JS every element is simply visible.
 */
function useLandingMotion(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.motion = "on";
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = "1";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));

    const par = Array.from(el.querySelectorAll<HTMLElement>("[data-parallax]"));
    let raf = 0;
    const tick = () => {
      raf = 0;
      const vh = innerHeight;
      for (const n of par) {
        const host = n.parentElement;
        if (!host) continue;
        const r = host.getBoundingClientRect();
        if (r.bottom < -300 || r.top > vh + 300) continue;
        const off = r.top + r.height / 2 - vh / 2;
        n.style.transform = `translate3d(0, ${(-off * Number(n.dataset.parallax)).toFixed(1)}px, 0)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    tick();
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      delete el.dataset.motion;
    };
  }, [root]);
}

/** Counts up to `to` the first time it is seen. Server render and reduced motion show the final number. */
function Count({ to, pad = 0 }: { to: number; pad?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(to);
  useEffect(() => {
    const el = ref.current;
    if (!el || to === 0 || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < innerHeight) return;
    setV(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 1400);
          setV(Math.round(to * (1 - Math.pow(1 - p, 4))));
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);
  return (
    <span ref={ref} className="num">
      {String(v).padStart(pad, "0")}
    </span>
  );
}

const rd = (i: number, step = 0.08) => ({ ["--rd" as string]: `${(i * step).toFixed(2)}s` });

function Facts() {
  const facts: [number, string, string][] = [
    [14, "days", "of warmup before any inbox sends a campaign email"],
    [40, "a day", "the most any single inbox will ever send"],
    [3, "records", "SPF, DKIM and DMARC set up on every sending domain"],
    [0, "cold emails", "sent from your main domain, ever"],
  ];
  return (
    <section className="lp-facts" aria-label="How Aperture protects your sending">
      <div className="wrap">
        <div className="lp-facts-in">
          {facts.map(([n, unit, text], i) => (
            <div className="lp-fact" key={text} data-reveal style={rd(i)}>
              <div className="lp-fact-n">
                <Count to={n} />
                <span>{unit}</span>
              </div>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { t: "Enter your domain", p: "We read your site to learn what you sell, who it is for and how you talk about it." },
  { t: "Meet your audience", p: "The industries, job titles and regions most likely to buy, each one you can edit." },
  { t: "See a free preview", p: "Your market size, real sample prospects and a written sequence. Nothing is sent and no card is needed." },
  { t: "Pick emails a day", p: "From 100 to 5,000 a day. Every email is $0.04, nothing else." },
  { t: "Add your card", p: "It unlocks $10 of free credit and nothing is charged. Remove it any time, in one click." },
  { t: "Launch the same day", p: "Your emails go out from senders that are already warmed up. No domains to buy, no weeks of warmup." },
];

function StepMock({ i, domain }: { i: number; domain: string }) {
  if (i === 0)
    return (
      <div className="m-card">
        <div className="m-url">
          <Icon id="globe" />
          <span className="mono">{domain}</span>
          <i className="m-caret" />
        </div>
        <div className="m-scan">
          {["/", "/pricing", "/customers", "/about"].map((p, k) => (
            <div className="m-scan-row" key={p} style={{ ["--k" as string]: k }}>
              <span className="mono">
                {domain}
                {p === "/" ? "" : p}
              </span>
              <b>
                <Icon id="check" />
                Read
              </b>
            </div>
          ))}
        </div>
      </div>
    );
  if (i === 1)
    return (
      <div className="m-card m-aud">
        {[
          ["Job titles", ["Head of Growth", "VP Sales", "Founder"]],
          ["Industries", ["B2B software", "Fintech"]],
          ["Regions", ["United States", "United Kingdom"]],
        ].map(([h, chips], g) => (
          <div key={h as string}>
            <small>{h as string}</small>
            <div className="m-chips">
              {(chips as string[]).map((c, k) => (
                <span key={c} style={{ ["--k" as string]: g * 3 + k }}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  if (i === 2)
    return (
      <div className="m-card m-prev">
        <div>
          <small>Companies in your market</small>
          <b className="num">12,480</b>
          <span className="m-note">Example numbers</span>
        </div>
        <div className="m-mail">
          <small>Email 1 of 3</small>
          <p>
            Quick idea for <span className="m-tk">company</span>
          </p>
          <i style={{ width: "92%" }} />
          <i style={{ width: "78%" }} />
          <i style={{ width: "64%" }} />
        </div>
      </div>
    );
  if (i === 3)
    return (
      <div className="m-card m-vol">
        <div className="m-vol-top">
          <span>Emails a day</span>
          <b className="num">1,000</b>
        </div>
        <div className="m-track">
          <i />
        </div>
        <div className="m-vol-out">
          <div>
            <b className="num">$40</b>
            <small>a day</small>
          </div>
          <div>
            <b className="num">250</b>
            <small>new people a day</small>
          </div>
          <div>
            <b className="num">$0.04</b>
            <small>an email</small>
          </div>
        </div>
      </div>
    );
  if (i === 4)
    return (
      <div className="m-card m-doms">
        {[
          ["$25", "625 emails"],
          ["$100", "2,500 emails"],
          ["Free", "250 emails to start"],
        ].map(([d, e], k) => (
          <div className="m-dom" key={d} style={{ ["--k" as string]: k }}>
            <span className="mono">{d}</span>
            <span className="m-fw">
              <Icon id="arr" />
              {e}
            </span>
            <span className="m-ok">
              <Icon id="check" />
              Prepaid
            </span>
          </div>
        ))}
      </div>
    );
  return (
    <div className="m-card m-warm">
      <div className="m-bars" aria-hidden="true">
        {Array.from({ length: 14 }, (_, k) => (
          <i key={k} style={{ ["--k" as string]: k, height: `${18 + (k / 13) ** 1.3 * 82}%` }} />
        ))}
      </div>
      <div className="m-warm-lbl">
        <span>Launch</span>
        <span className="m-ready">
          <span className="pulse" />
          Sending today
        </span>
      </div>
    </div>
  );
}

function HowItWorks({ domain }: { domain: string }) {
  const [active, setActive] = useState(0);
  const cards = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    cards.current.forEach((c) => c && io.observe(c));
    return () => io.disconnect();
  }, []);
  const go = (i: number) => cards.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <section className="sec" id="how">
      <div className="wrap lp-how">
        <div className="lp-how-l">
          <div className="lp-how-stick">
            <div className="eyebrow" data-reveal>
              How it works
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              From domain to first reply <span className="dim">in one sitting.</span>
            </h2>
            <p className="sec-lede" data-reveal style={rd(2)}>
              Six steps, in this order. You see your audience and a written sequence for free, and you only pay once you are happy with the plan.
            </p>
            <ol className="lp-prog" data-reveal style={{ ...rd(3), ["--p" as string]: active / (STEPS.length - 1) }}>
              {STEPS.map((s, i) => (
                <li key={s.t} data-state={i < active ? "done" : i === active ? "on" : undefined}>
                  <button type="button" onClick={() => go(i)}>
                    <span className="lp-prog-n">{i < active ? <Icon id="check" /> : i + 1}</span>
                    {s.t}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="lp-how-r">
          {STEPS.map((s, i) => (
            <article
              key={s.t}
              className="lp-step"
              data-i={i}
              data-on={i === active ? "1" : undefined}
              ref={(n) => {
                cards.current[i] = n;
              }}
              data-reveal
            >
              <div className="lp-step-h">
                <span className="lp-step-n mono">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{s.t}</h3>
                  <p>{s.p}</p>
                </div>
              </div>
              <StepMock i={i} domain={domain} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const REPLIES = [
  { n: "Maya Reid", m: "This is timely. Are you free Thursday at 3?", c: "Hot", k: "g" },
  { n: "Daniel Kerr", m: "What does onboarding look like for a team of 12?", c: "Question", k: "b" },
  { n: "Chris Bell", m: "Not this quarter. Try me again in January.", c: "Not now · 8 Jan", k: "y" },
  { n: "Priya Shah", m: "Tom owns this on our side, copying him in.", c: "Referral", k: "v" },
  { n: "Sofia Lund", m: "Out of office until the 14th, back after that.", c: "Away · 14 Oct", k: "y" },
  { n: "Owen Hart", m: "Please take me off your list.", c: "Stop · blocked", k: "r" },
];

function Product() {
  return (
    <section className="sec" id="product">
      <div className="lp-orb lp-orb-a" aria-hidden="true">
        <i data-parallax="0.18" />
      </div>
      <div className="wrap">
        <div className="sec-head">
          <div>
            <div className="eyebrow" data-reveal>
              After launch
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              The busywork after the send <span className="dim">is ours.</span>
            </h2>
          </div>
          <p className="sec-lede" data-reveal style={rd(2)}>
            Replies get sorted with an answer drafted, new leads wait for your OK each week, and every opt out is honoured the moment it arrives.
          </p>
        </div>

        <div className="lp-bento">
          <article className="lp-cell lp-c-inbox" data-reveal>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="inbox" />
              </span>
              <h3>Every reply sorted, with a draft waiting</h3>
              <p>Interested, question, not now, referral or stop. Leads get a reply written for you, and a not now gets a follow up date.</p>
            </div>
            <div className="lp-inbox">
              <div className="lp-inbox-bar">
                <span data-on="1">
                  All <b>6</b>
                </span>
                <span>
                  Leads <b>3</b>
                </span>
                <span>
                  Later <b>2</b>
                </span>
                <span>
                  Stopped <b>1</b>
                </span>
              </div>
              {REPLIES.map((r, i) => (
                <div className="lp-rep" key={r.n} data-sel={i === 0 ? "1" : undefined} style={{ ["--k" as string]: i }}>
                  <span className="lp-av">
                    {r.n
                      .split(" ")
                      .map((x) => x[0])
                      .join("")}
                  </span>
                  <div className="lp-rep-t">
                    <b>{r.n}</b>
                    <p>{r.m}</p>
                  </div>
                  <span className={`chip-s ${r.k}`}>{r.c}</span>
                </div>
              ))}
              <div className="lp-draft">
                <small>
                  <Icon id="sparkle" />
                  Draft for Maya
                </small>
                <blockquote>This is timely. Are you free Thursday at 3?</blockquote>
                <p>Thursday at 3 works. I have sent an invite to this address, and I will bring the numbers we talked about.</p>
                <span className="lp-draft-b">Review and send</span>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-c-week" data-reveal style={rd(1)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="users" />
              </span>
              <h3>Leads you approve each week</h3>
              <p>A fresh batch lands every week. Nothing goes out until you approve it, in the app or from Slack.</p>
            </div>
            <div className="lp-week">
              <div className="lp-week-top">
                <span>Next week</span>
                <b className="num">212 leads</b>
              </div>
              <div className="lp-week-bar">
                <i />
              </div>
              <div className="lp-week-row">
                <span className="lp-week-ok">
                  <Icon id="check" />
                  Approve week
                </span>
                <small>or in one click from Slack</small>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-c-block" data-reveal style={rd(2)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="ban" />
              </span>
              <h3>Opt outs honoured instantly</h3>
              <p>Unsubscribes and bounces go straight to your blocklist, and anything still queued for them stops.</p>
            </div>
            <div className="lp-block">
              {[
                ["j.moss@", "Unsubscribed"],
                ["team@", "Bounced"],
              ].map(([a, why]) => (
                <div key={a}>
                  <span className="mono">{a}…</span>
                  <em>{why}</em>
                  <b>Blocked</b>
                </div>
              ))}
            </div>
          </article>

          <article className="lp-cell lp-c-slack" data-reveal>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="pulse" />
              </span>
              <h3>Reports in Slack</h3>
              <p>Daily, weekly and monthly numbers posted to your channel, so nobody has to log in to know how it is going.</p>
            </div>
            <div className="lp-slack">
              <span className="lp-slack-av">
                <Mark />
              </span>
              <div>
                <div className="lp-slack-who">
                  <b>Aperture</b>
                  <small>Monday 9:00</small>
                </div>
                <b className="lp-slack-t">Weekly outreach report</b>
                <div className="lp-slack-kv">
                  {[
                    ["Sent", "2,140"],
                    ["Replies", "41"],
                    ["New leads", "212"],
                    ["Meetings", "6"],
                  ].map(([k, v]) => (
                    <span key={k}>
                      {k} <b className="num">{v}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-c-csv" data-reveal style={rd(1)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="upload" />
              </span>
              <h3>Bring your own list</h3>
              <p>Upload a CSV, use the audience we find, or mix both. Every address is checked before it gets an email.</p>
            </div>
            <div className="lp-csv">
              <span className="mono">leads.csv</span>
              <span>
                <b className="num">1,204</b> checked
              </span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

const POINTS: { ic: IconId; h: string; p: (base: string) => React.ReactNode }[] = [
  {
    ic: "shield",
    h: "Managed sending, never your domain",
    p: () => <>Emails go out from warmed-up sending domains we run and watch, so the reputation of your own domain stays untouched.</>,
  },
  { ic: "key", h: "Every address verified first", p: () => "Nothing is sent to an address that fails verification or sits on a catch-all server, so bounces stay low." },
  { ic: "flame", h: "Health watched for you", p: () => "Your bounce rate is on your credits page. If it climbs we warn you, and above 4% new emails pause until your list is checked again." },
  { ic: "rotate", h: "One sender per conversation", p: () => "Each person always hears from the same sender, so follow-ups and replies stay in one thread." },
];

function Deliverability({ domain }: { domain: string }) {
  const base = domain.split(".")[0];
  const orb = ["Verified", "Warmed up", "No tracking pixels", "Unsubscribe link", "Bounces under 2%"];
  return (
    <section className="sec" id="deliverability">
      <div className="lp-orb lp-orb-b" aria-hidden="true">
        <i data-parallax="-0.14" />
      </div>
      <div className="wrap deliv lp-deliv">
        <div>
          <div className="eyebrow" data-reveal>
            Deliverability
          </div>
          <h2 className="h2" data-reveal style={rd(1)}>
            Your main domain never sends <span className="dim">a cold email.</span>
          </h2>
          <div className="lp-points">
            {POINTS.map((x, i) => (
              <div className="lp-point" key={x.h} data-reveal style={rd(i + 2)}>
                <span className="lp-ic">
                  <Icon id={x.ic} />
                </span>
                <div>
                  <h3>{x.h}</h3>
                  <p>{x.p(base)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-par-host">
          <div data-parallax="0.05">
            <div className="orbit-card glass" data-reveal style={rd(2)}>
              <div className="orbit" aria-hidden="true">
                <div className="ring" style={{ ["--i" as string]: "0%" }} />
                <div className="ring" style={{ ["--i" as string]: "19%" }} />
                {[
                  ["0%", "60s", "0s", ""],
                  ["0%", "60s", "-20s", ""],
                  ["0%", "60s", "-40s", ""],
                  ["19%", "44s", "-7s", "rev"],
                  ["19%", "44s", "-29s", "rev"],
                ].map(([i, t, d, rev], k) => (
                  <div key={k} className={`spin ${rev}`} style={{ ["--i" as string]: i, ["--t" as string]: t, ["--d" as string]: d }}>
                    <div className="sat">
                      <span>{orb[k]}</span>
                    </div>
                  </div>
                ))}
                <div className="core">
                  <div>
                    <b>{domain}</b>
                    <small>
                      <Icon id="shield" />
                      protected
                    </small>
                  </div>
                </div>
              </div>
              <div className="dns">
                <table>
                  <tbody>
                    {[
                      ["TXT", "@", "v=spf1 include:… ~all", "SPF"],
                      ["TXT", "s1._domainkey", "v=DKIM1; k=rsa; p=MIIBIjANBgkqh…", "DKIM"],
                      ["TXT", "_dmarc", "v=DMARC1; p=quarantine; rua=mailto:…", "DMARC"],
                      ["MX", "@", "mail exchanger for replies", "MX"],
                    ].map((r) => (
                      <tr key={r[3]}>
                        <td>{r[0]}</td>
                        <td>{r[1]}</td>
                        <td>{r[2]}</td>
                        <td className="ok">{r[3]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


const INCLUDED = [
  "Warmed-up senders, ready on day one",
  "Every address verified before it is emailed",
  "Each email written for the person",
  "Replies sorted with drafts written",
  "Replies to your prospects are free",
  "Prepaid credit, close your account any time",
];

function Pricing() {
  const { data: cat, isLoading, isError, refetch } = usePlansQuery();
  const [v, setV] = useState(500);
  const stop = cat?.volume.stops.find((x) => x.emails === v) ?? null;
  return (
    <section className="sec" id="pricing">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <div className="eyebrow" data-reveal>
              Pricing
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              $0.04 an email. <span className="dim">Every email.</span>
            </h2>
          </div>
          <p className="sec-lede" data-reveal style={rd(2)}>
            One flat price for the first email, every follow-up and every reply, with finding the person, verifying the address and writing the message included. If we can&apos;t find an address you pay nothing. Run out of credit and your cold email pauses; your live conversations don&apos;t. No plan, no seats, no setup fee. Your leads are yours: export them any time.
          </p>
        </div>
        <div className="price-card glass lp-price" data-reveal>
          <div className="pc-l">
            <label htmlFor="lpRange" className="lp-price-lbl">
              How many emails a day?
            </label>
            <div className="vol-num">
              <output className="num" htmlFor="lpRange">
                {n0(v)}
              </output>
              <span>emails a day</span>
            </div>
            {cat ? (
              <>
                <input
                  id="lpRange"
                  className="range"
                  type="range"
                  min={cat.volume.min}
                  max={cat.volume.max}
                  step={cat.volume.step}
                  value={v}
                  onChange={(e) => setV(+e.target.value)}
                  style={{ ["--p" as string]: `${((v - cat.volume.min) / (cat.volume.max - cat.volume.min)) * 100}%` }}
                />
                <div className="ticks">
                  <span>{n0(cat.volume.min)}</span>
                  <span>1,000</span>
                  <span>2,500</span>
                  <span>{n0(cat.volume.max)}</span>
                </div>
                <div className="presets">
                  {cat.volume.presets.map((x) => (
                    <button key={x} className="pill-btn" type="button" aria-pressed={x === v} onClick={() => setV(x)}>
                      {n0(x)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <div className="pc-r">
            {cat ? (
              <>
                <div className="lines">
                  <div className="line">
                    <span>
                      Every email<small>First email, follow-ups on days 3, 7 and 14, and replies, all the same price</small>
                    </span>
                    <b>{cat.pricing.perEmail}</b>
                  </div>
                  {stop ? (
                    <div className="line">
                      <span>
                        {n0(stop.emails)} emails a day<small>{n0(stop.people)} new people a day, each with a 4-email sequence</small>
                      </span>
                      <b>{stop.perDay}/day</b>
                    </div>
                  ) : null}
                  <div className="line">
                    <span>
                      Free credit<small>Add a card and get {cat.pricing.freeTrial.amount.replace(".00", "")}, about {n0(cat.pricing.freeTrial.emails)} emails. Nothing is charged, and you can remove the card any time.</small>
                    </span>
                    <b>{cat.pricing.freeTrial.amount.replace(".00", "")}</b>
                  </div>
                  <div className="line">
                    <span>
                      Top-ups<small>Prepaid, only when you choose. Never charged automatically unless you switch on auto-reload.</small>
                    </span>
                    <b>From {cat.pricing.minTopup.replace(".00", "")}</b>
                  </div>
                </div>
                {stop ? (
                  <div className="total">
                    <span>About a month</span>
                    <b className="num">
                      {stop.perMonth}
                      <small> at {n0(stop.emails)} a day</small>
                    </b>
                  </div>
                ) : null}
              </>
            ) : isError ? (
              <div className="errbox" style={{ padding: 20 }}>
                <b>Prices didn&apos;t load</b>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => refetch()}>
                  Try again
                </button>
              </div>
            ) : isLoading ? (
              <div style={{ display: "grid", gap: 14 }}>
                <Skeleton h={44} />
                <Skeleton h={44} />
                <Skeleton h={44} />
                <Skeleton h={56} />
              </div>
            ) : null}
            <Link className="btn btn-primary" style={{ width: "100%", marginTop: 22 }} href="/onboarding">
              Start free
              <Icon id="arr" className="arr" />
            </Link>
            <p className="lp-price-note">The analysis and preview are free. Start with free credit, then top up from $25 when you like the replies.</p>
          </div>
        </div>
        <div className="lp-incl" data-reveal>
          <span className="lp-incl-h">Included in every email</span>
          <ul>
            {INCLUDED.map((x, i) => (
              <li key={x} data-reveal style={rd(i, 0.05)}>
                <Icon id="check" />
                {x}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  ["Why not send from my own domain?", "Cold email carries reputation risk. If a campaign trips a spam filter, you want that to happen on a spare domain, not the one your customers and invoices depend on."],
  ["How soon do emails go out?", "The same day you launch. Your emails go out from senders that are already warmed up, so there is no waiting period."],
  ["What is in the free preview?", "An analysis of your business, the size of your market, sample prospects, a four step email sequence written for it and a recommended daily pace. No email is sent and no card is needed."],
  ["How does pricing work?", "$0.04 for every email, the first one and each follow-up, paid from a prepaid balance you top up from $25. That includes finding the person, verifying their address and writing every message, replies included. If we can't find someone's address you pay nothing, and the last $2 of your balance is kept for replies, so a conversation never stops mid-thread because cold email used up the credit. Adding a card unlocks $10 of free credit and charges nothing; remove the card any time in one click. Nothing is ever charged automatically unless you switch on auto-reload."],
  ["Can I export my leads?", "Yes. Your leads are yours. Export every person, with their full email address, any time, free. Nothing is masked and there is no reveal charge."],
  ["Does anything send without my say-so?", "No. Your first 20 people and their emails wait for your approval, with no timer. Replies we draft wait for you to press Send."],
  ["What happens when someone replies?", "Each reply is sorted as interested, question, not now, referral or stop. Leads get a drafted answer for you to send, a not now gets a follow up date, and a stop goes straight to your blocklist."],
  ["Do I need my own sending domains?", "No. Sending runs on domains we manage, watch and replace when needed. Your own domain never sends a cold email."],
  ["Can I bring my own lead list?", "Yes. Upload a CSV on the launch screen, use the audience we find, or mix both. We check every address before it gets an email."],
  ["Can I stop any time?", "Yes. There is no subscription. Pause sending whenever you like, remove your card, or close your account from the credits page in a couple of clicks."],
];

function Faq() {
  return (
    <section className="sec" id="faq">
      <div className="wrap faq lp-faq">
        <div>
          <div className="lp-faq-stick">
            <div className="eyebrow" data-reveal>
              FAQ
            </div>
            <h2 className="h2" data-reveal style={rd(1)}>
              Good questions.
            </h2>
            <div className="lp-help" data-reveal style={rd(2)}>
              <b>See it on your own site first</b>
              <p>The preview reads your site and writes your first sequence. It is free and nothing is sent.</p>
              <Link className="btn btn-glass btn-sm" href="/onboarding">
                Start the free preview
                <Icon id="arr" className="arr" />
              </Link>
            </div>
          </div>
        </div>
        <div className="lp-qas">
          {FAQS.map(([q, a], i) => (
            <details className="qa" key={q} open={i === 0} data-reveal style={rd(i, 0.04)}>
              <summary>
                {q}
                <i>
                  <Icon id="plus" />
                </i>
              </summary>
              <div className="lp-qa-a">
                <p>{a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  const [domain, setDomain] = useState("northwind.io");
  const root = useRef<HTMLDivElement>(null);
  useLiquidGlassAll(root, GLASS_CARDS);
  useLandingMotion(root);

  return (
    <div id="landing" ref={root}>
      <Nav />
      <main id="top">
        <section className="hero">
          <div className="hero-sky" aria-hidden="true" />
          <div className="hero-in wrap">
            <p className="hero-kicker">Cold email infrastructure, set up by an agent</p>
            <h1 className="display">
              <span className="ln">
                <span>Type your domain.</span>
              </span>
              <span className="ln l2">
                <span>We build the outbound.</span>
              </span>
            </h1>
            <p className="lede">Aperture reads your site, finds your buyers, then plans, warms and launches your sending domains. Your main domain never sends a cold email.</p>
            <div className="lq-stage">
              <DomainSearch id="heroDomain" hero onDomain={setDomain} />
            </div>
            <Console domain={domain} />
          </div>
        </section>

        <Facts />
        <HowItWorks domain={domain} />
        <Product />
        <Deliverability domain={domain} />
        <Pricing />
        <Faq />

        <div className="wrap">
          <div className="cta glass lp-cta" data-reveal>
            <div className="lp-cta-bg" aria-hidden="true">
              <i className="lp-cta-o1" data-parallax="0.12" />
              <i className="lp-cta-o2" data-parallax="-0.1" />
            </div>
            <div className="eyebrow">Ready when you are</div>
            <h2 className="h2" style={{ marginTop: 14 }}>
              Your first campaign is one domain away.
            </h2>
            <DomainSearch id="ctaDomain" cta onDomain={setDomain} />
            <ul className="lp-cta-perks">
              <li>
                <Icon id="check" />
                Free preview
              </li>
              <li>
                <Icon id="check" />
                No card needed
              </li>
              <li>
                <Icon id="check" />
                Nothing is sent until you launch
              </li>
            </ul>
          </div>
        </div>
      </main>

      <footer className="site-foot lp-foot">
        <div className="wrap">
          <div className="lp-foot-top">
            <div className="lp-foot-brand">
              <a className="logo" href="#top">
                <Mark />
                Aperture
              </a>
              <p>Cold email infrastructure, set up by an agent. Your main domain never sends a cold email.</p>
            </div>
            <nav aria-label="Product">
              <b>Product</b>
              <a href="#how">How it works</a>
              <a href="#product">After launch</a>
              <a href="#deliverability">Deliverability</a>
              <a href="#pricing">Pricing</a>
            </nav>
            <nav aria-label="Get started">
              <b>Get started</b>
              <Link href="/onboarding">Free preview</Link>
              <Link href="/signin">Sign in</Link>
              <a href="#faq">FAQ</a>
            </nav>
          </div>
          <div className="lp-foot-bot">
            <span>© {new Date().getFullYear()} Aperture</span>
            <a href="#top" className="lp-top">
              Back to top
              <Icon id="arr" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
