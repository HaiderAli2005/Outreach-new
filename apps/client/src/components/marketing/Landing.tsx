"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { useEffect, useRef, useState } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/primitives";
import { DomainSearch } from "./DomainSearch";
import { useLiquidGlass } from "@/components/ui/liquidGlass";
import { usePlansQuery } from "@/store/api";
import { useSessionBootstrap } from "@/components/shell/session";
import { n0 } from "@/lib/format";
import { FAQS } from "@/lib/landingContent";

const EXAMPLE_FEED = [
  { n: "Maya Reid", r: "Loomwork", m: "This is timely. Are you free Thursday at 3?", t: "Interested", c: "g", av: "#8A6A45" },
  { n: "Daniel Kerr", r: "Brightlabs", m: "Send over pricing and a short case study?", t: "Question", c: "b", av: "#6B5B4A" },
  { n: "Priya Shah", r: "Parcelry", m: "Loop in Tom, he owns this on our side.", t: "Referral", c: "v", av: "#A07F55" },
  { n: "Chris Bell", r: "Harbor & Co", m: "Not this quarter. Try me again in January.", t: "Later · 8 Jan", c: "y", av: "#5E5850" },
  { n: "Sofia Lund", r: "Fernway", m: "Yes, let's talk. Here's my calendar link.", t: "Interested", c: "g", av: "#6E7F63" },
];

function Nav() {
  const bar = useRef<HTMLDivElement>(null);
  // The bezel spans the whole height of the bar, so text passing behind it bends like it does under a glass pill instead
  // of only along a thin rim; the extra blur keeps the links readable over it. Steady: it stays on while scrolling.
  useLiquidGlass(bar, { scale: 34, bezel: 30, blur: 3, steady: true });
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
          <ThemeToggle />
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
/** 4 sending domains, 3 mailboxes each, 30 emails a mailbox a day: the real ceiling for this example. */
const DAY_MAX = 360;

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
  const [sent, setSent] = useState(236);
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
      setPlaced(98.1);
      return;
    }
    setMotion(true);
    const g = setTimeout(() => setPlaced(98.1), 300);
    const a = setInterval(() => setFeedI((i) => (i + EXAMPLE_FEED.length - 1) % EXAMPLE_FEED.length), 3600);
    const b = setInterval(() => setSent((s) => (s >= DAY_MAX ? 214 : Math.min(DAY_MAX, s + 1 + Math.floor(Math.random() * 3)))), 1400);
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
            Sending · 12 mailboxes
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
              <span>Writing now · email 1 of 4</span>
              <span>sends 9:42am, their time</span>
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
              <span>mailbox 7 of 12 · 30 a day</span>
            </div>
          </div>
          <div className="fl-land">
            <p className="fl-lb">Replies</p>
            <div className="fl-ga">
              <svg viewBox="0 0 46 46" aria-hidden="true">
                <circle cx="23" cy="23" r="19" className="fl-ga-bg" />
                <circle cx="23" cy="23" r="19" className="fl-ga-on" style={{ strokeDashoffset: 119.4 * (1 - placed / 100) }} />
              </svg>
              <div>
                <small>Delivered, last 7 days</small>
                <b className="num">98.1%</b>
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
            Sent today<b className="num">{sent} of {DAY_MAX}</b>
          </div>
          <div>
            Mailboxes<b className="num">12 sending</b>
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
    [6, "weeks", "of aging and warmup behind every sending domain before its first campaign email"],
    [30, "a day", "the most any one mailbox sends, so every sender stays inside safe limits"],
    [4, "emails", "per person, on days 0, 3, 7 and 14, all in one thread"],
    [0, "cold emails", "sent from your main domain, ever"],
  ];
  return (
    <section className="lp-facts" aria-label="How Aperture protects your sending reputation">
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
  { t: "Enter your domain", p: "Aperture reads your website to learn what you sell, who buys it and how you describe it. No forms, no call." },
  { t: "Meet your buyers", p: "Your audiences, ranked by where to start: job titles, seniority, company size and countries, each one yours to edit." },
  { t: "Get a free overview", p: "How many people match, real sample prospects and a written four-email sequence. Nothing is sent and no card is needed." },
  { t: "Set your daily budget", p: "From $4 to $200 a day, which is 100 to 5,000 emails. Every email is $0.04, and the budget is a ceiling, never a target." },
  { t: "Add your card", p: "It unlocks $10 of free credit, about 250 emails, and nothing is charged. Top up from $25 when you like the replies." },
  { t: "Launch the same day", p: "Emails go out from mailboxes that are already warmed, in each person's own working hours. Your cockpit shows every send." },
];

/** Today's sends in the cockpit: one slot per send across the working day, sent ones solid, booked ones light. */
const TODAY = [9, 9.2, 9.5, 9.9, 10.1, 10.4, 10.6, 10.9, 11.3, 11.6, 12.1, 12.4, 13.2, 13.5, 13.9, 14.3, 14.6, 15, 15.4, 15.8, 16.1, 16.5];
const NOW_AT = 13.3;

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
        <div className="m-aud-h">
          <div>
            <span className="m-badge">Run first</span>
            <b>Growth teams at B2B software companies</b>
          </div>
          <span className="m-aud-n">
            <b className="num">10,466</b>
            <small>people match</small>
          </span>
        </div>
        <div>
          <small>Job titles</small>
          <div className="m-chips">
            {["Head of Growth", "VP Marketing", "Demand Generation Manager"].map((c, k) => (
              <span key={c} style={{ ["--k" as string]: k }}>
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="m-kv">
          <div>
            <small>Seniority</small>
            <span>VP, Head, Director</span>
          </div>
          <div>
            <small>Company size</small>
            <span>51 to 500 employees</span>
          </div>
          <div>
            <small>Countries</small>
            <span>US, UK</span>
          </div>
        </div>
      </div>
    );
  if (i === 2)
    return (
      <div className="m-card m-prev">
        <div>
          <small>People match your buyers</small>
          <b className="num">26,493</b>
          <span className="m-note">17,958 with a reachable email</span>
        </div>
        <div className="m-people">
          {[
            ["Kazuhiko S.", "Head of Growth at Loomwork"],
            ["Alessandra T.", "VP Marketing at Fernway"],
            ["Daniel K.", "Demand Gen Manager at Brightlabs"],
          ].map(([n, r], k) => (
            <div className="m-person" key={n} style={{ ["--k" as string]: k }}>
              <span className="m-av">{n[0]}</span>
              <div>
                <b>{n}</b>
                <small>{r}</small>
              </div>
            </div>
          ))}
          <p className="m-hint">Surnames and addresses stay hidden until you launch.</p>
        </div>
      </div>
    );
  if (i === 3)
    return (
      <div className="m-card m-vol">
        <div className="m-vol-top">
          <span>Daily budget</span>
          <b className="num">$20 a day</b>
        </div>
        <div className="m-track">
          <i style={{ width: "8.1%" }} />
        </div>
        <div className="m-vol-out">
          <div>
            <b className="num">500</b>
            <small>emails a day</small>
          </div>
          <div>
            <b className="num">125</b>
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
          ["Free credit", "$10.00", "about 250 emails"],
          ["Charged today", "$0.00", "nothing until you top up"],
          ["Top-ups", "from $25", "prepaid, auto-reload off"],
        ].map(([k, v, note], j) => (
          <div className="m-dom m-line" key={k} style={{ ["--k" as string]: j }}>
            <span>{k}</span>
            <span className="m-fw">{note}</span>
            <b className="num">{v}</b>
          </div>
        ))}
      </div>
    );
  return (
    <div className="m-card m-today">
      <div className="m-vol-top">
        <span>Today&apos;s sends</span>
        <span className="m-now">
          <span className="pulse" />
          Now 1:18pm in London
        </span>
      </div>
      <div className="m-line-track" aria-hidden="true">
        {TODAY.map((h, k) => (
          <i key={h} data-sent={h < NOW_AT ? "1" : undefined} style={{ left: `${((h - 9) / 8) * 100}%`, ["--k" as string]: k }} />
        ))}
        <em style={{ left: `${((NOW_AT - 9) / 8) * 100}%` }} />
      </div>
      <div className="m-axis">
        <span>9am</span>
        <span>11am</span>
        <span>1pm</span>
        <span>3pm</span>
        <span>5pm</span>
      </div>
      <div className="m-warm-lbl">
        <span>
          <b className="num">13</b> sent · <b className="num">9</b> to go · next 1:30pm
        </span>
        <span className="m-ready">
          <Icon id="check" />
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
              Six steps, in this order. Your buyers, your market size and a written sequence are free to see, and you only pay once the plan looks right.
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
  { n: "Maya Reid", m: "This is timely. Are you free Thursday at 3?", c: "Interested", k: "g" },
  { n: "Daniel Kerr", m: "What does onboarding look like for a team of 12?", c: "Question", k: "b" },
  { n: "Chris Bell", m: "Not this quarter. Try me again in January.", c: "Later · 8 Jan", k: "y" },
  { n: "Priya Shah", m: "Tom owns this on our side, copying him in.", c: "Referral", k: "v" },
  { n: "Sofia Lund", m: "Out of office until the 14th, back after that.", c: "Away · 14 Oct", k: "v" },
  { n: "Owen Hart", m: "Please take me off your list.", c: "Unsubscribe", k: "r" },
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
              After the send, <span className="dim">the busywork is ours.</span>
            </h2>
          </div>
          <p className="sec-lede" data-reveal style={rd(2)}>
            Every reply is read and sorted with an answer drafted, new people can wait for your OK each week, and every unsubscribe is honoured the moment it arrives.
          </p>
        </div>

        <div className="lp-bento">
          <article className="lp-cell lp-c-inbox" data-reveal>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="inbox" />
              </span>
              <h3>Every reply sorted, with a draft waiting</h3>
              <p>Interested, question, later, referral, away or unsubscribe. Interested people and questions get a reply drafted for you, and a later gets a follow-up date.</p>
            </div>
            <div className="lp-inbox">
              <div className="lp-inbox-bar">
                <span data-on="1">
                  All <b>6</b>
                </span>
                <span>
                  Needs reply <b>2</b>
                </span>
                <span>
                  Handled <b>4</b>
                </span>
                <span>Sent only</span>
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
              <h3>A week review, if you want one</h3>
              <p>Next week&apos;s new people wait for your OK, and Slack tells you when they are ready. Or let them go out automatically.</p>
            </div>
            <div className="lp-week">
              <div className="lp-week-top">
                <span>Week of 9 Nov</span>
                <b className="num">212 people</b>
              </div>
              <div className="lp-week-bar">
                <i />
              </div>
              <div className="lp-week-row">
                <span className="lp-week-ok">
                  <Icon id="check" />
                  Approve week
                </span>
                <small>or leave out anyone first</small>
              </div>
            </div>
          </article>

          <article className="lp-cell lp-c-block" data-reveal style={rd(2)}>
            <div className="lp-cell-h">
              <span className="lp-ic">
                <Icon id="ban" />
              </span>
              <h3>Unsubscribes honoured instantly</h3>
              <p>Unsubscribes and hard bounces go straight to your blocklist, and anything still queued for them stops at once.</p>
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
              <h3>Slack, the moment it matters</h3>
              <p>A ping when someone replies, a draft is waiting or a meeting is booked, plus daily, weekly and monthly reports in your channel.</p>
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
                    ["Meetings booked", "6"],
                    ["Removed", "9"],
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
              <h3>Your list, ours, or Google Maps</h3>
              <p>Upload a CSV, use the people we find, or add local businesses from Google Maps. Every address is verified before it is emailed.</p>
            </div>
            <div className="lp-csvs">
              <div className="lp-csv">
                <span className="mono">leads.csv</span>
                <span>
                  <b className="num">1,204</b> verified
                </span>
              </div>
              <div className="lp-csv">
                <span>
                  <Icon id="pin" /> Dental clinics · Riyadh
                </span>
                <span>
                  <b className="num">86</b> found on Maps
                </span>
              </div>
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
    h: "Managed sending domains, never yours",
    p: (base) => <>Emails go out from sending domains we buy, set up, age and warm, like get{base}.com, with SPF, DKIM and DMARC in place. Your own domain&apos;s reputation stays untouched.</>,
  },
  { ic: "key", h: "Every address verified first", p: () => "Nothing is sent to an address that fails verification or sits on a catch-all server, which keeps bounces low from the first day." },
  { ic: "flame", h: "Limits that protect every sender", p: () => "Each mailbox sends at most 30 emails a day, and your bounce rate is watched for you. Above 4%, new emails pause until your list is checked again." },
  { ic: "rotate", h: "Plain text, one thread, one sender", p: () => "No tracking pixels and no rewritten links. Each person always hears from the same mailbox, and every follow-up replies in the same thread." },
];

function Deliverability({ domain }: { domain: string }) {
  const base = domain.split(".")[0];
  const orb = ["Verified", "Warmed 6 weeks", "No tracking pixels", "Unsubscribe link", "30 a day max"];
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
  "Warmed-up sending domains, ready on day one",
  "Finding the person and verifying the address",
  "A four-email sequence written for each person",
  "Every reply read, sorted and drafted",
  "$2 always kept for replies in live conversations",
  "Export every lead any time, free",
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
            One flat price for the first email, every follow-up and every reply. Finding the person, verifying the address and writing the message are included, and if we can&apos;t find an address you pay nothing. Prepaid, with no plan, no seats and no setup fee. If your credit runs out, cold email pauses and your live conversations keep going.
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
              Questions about cold email, answered.
            </h2>
            <div className="lp-help" data-reveal style={rd(2)}>
              <b>See it on your own domain first</b>
              <p>The free overview reads your site, sizes your market and writes your first sequence. No card, and nothing is sent.</p>
              <Link className="btn btn-glass btn-sm" href="/onboarding">
                Start the free overview
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
  useLandingMotion(root);

  return (
    <div id="landing" ref={root}>
      <Nav />
      <main id="top">
        <section className="hero">
          <div className="hero-sky" aria-hidden="true" />
          <div className="hero-in wrap">
            <p className="hero-kicker">AI cold email software · sending domains included</p>
            <h1 className="display">
              <span className="ln">
                <span>Cold email that books meetings.</span>
              </span>
              <span className="ln l2">
                <span>Your domain stays clean.</span>
              </span>
            </h1>
            <p className="lede">Type your domain. Aperture reads your website, finds the people most likely to buy, writes a personal email to each one and sends it from warmed-up domains we run. $0.04 an email, and your main domain never sends a cold email.</p>
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
              <p>AI cold email software with warmed-up sending domains included. Your main domain never sends a cold email.</p>
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
