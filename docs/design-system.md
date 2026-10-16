# Design system

Extracted from `aperture-desert-gold_2.html` (the "Desert Gold" theme layered over the base Aperture
tokens). The source defines the base tokens first and then overrides them in a later `DESERT GOLD` block;
the values below are the final, effective ones.

## Tokens

Defined once as CSS variables in `apps/client/src/app/globals.css` and mapped into Tailwind in
`tailwind.config.ts`, so components use either `var(--gold)` or `text-gold`.

| Token | Value | Use |
|---|---|---|
| `--bg` / `--bg-2` / `--bg-3` | `#0F0E0D` / `#161513` / `#1D1B19` | page, raised, sunken |
| `--ink` … `--ink-4` | `#F2EEE7` `#B9B1A5` `#857D72` `#57514A` | text, secondary, tertiary, disabled |
| `--gold` / `--gold-2` / `--gold-deep` / `--gold-soft` | `#D4AE72` `#C2A06B` `#A67B5B` `#E9D3B0` | accent family |
| `--on-gold` | `#15100C` | text on gold fills |
| `--good` / `--warn` / `--bad` | `#8CCB9F` `#E3B25C` `#E5836F` | status |
| `--line` / `--line-2` | `rgba(255,240,220,.08)` / `.14` | hairlines |
| `--grad` | `linear-gradient(180deg,#E2C28C,#C9A36A)` | primary buttons, active dots |
| `--gold-text` | `linear-gradient(180deg,#F5E6C8,#DDB97D 55%,#B8905E)` | gradient headline text |
| `--glass-fill` | champagne-tinted vertical gradient | every glass surface |
| `--r-sm` / `--r` / `--r-lg` | 12 / 20 / 28 px | radius scale; pills are 999px |
| `--ease` / `--ease-out` | `cubic-bezier(.2,.7,.2,1)` / `(.16,1,.3,1)` | transitions / entrances |

## Typography

* Body and display: **Geist** (the Desert Gold block overrides the display face from Bricolage Grotesque to
  Geist). Mono: **Geist Mono** for numbers, domains, keys and labels.
* Loaded with `next/font/google` (self-hosted at build time, no layout shift).
* Scale used by the source: display `clamp(40px,5.2vw,70px)/1.03`, section `clamp(34px,4.6vw,60px)`,
  view heading `clamp(32px,3.6vw,48px)/1.02`, panel titles 17–18px/600, body 15px/1.55, small 13–13.5px,
  mono labels 11.5–12px uppercase with `.1em` tracking. Headings use negative tracking (`-.02em` to `-.046em`).
* Numbers use `font-variant-numeric: tabular-nums` (`.num`).

## Surfaces

* **Glass** (`.glass`): gradient fill, `backdrop-filter: blur(16px) saturate(130%)`, inset top highlight,
  a 1px gradient hairline drawn with a masked `::before`, and a pointer-following specular `::after`.
  Component: `<Glass>`.
* **Pane** (`.pane`): flat `rgba(24,22,20,.72)` panel with a 1px inset line, used inside glass.
* **Card** 22px padding, 24px radius. **Panel** 22px padding, 22px radius with an `h3` + mono `small`.

## Components (source class → React component)

| Source | Component | Notes |
|---|---|---|
| `.btn-primary`, `.btn-ghost`, `.btn-text`, `.btn-sm` | `Button` (`variant`, `size`, `loading`) | 46px pill, gold gradient primary |
| `.pill-btn[aria-pressed]` | `PillToggle` | presets, filter chips |
| `.seg` | `Segmented` | 2–5 options, `aria-pressed` |
| `.field` + `.input` / `textarea.input` | `Field`, `Input`, `Textarea`, `Select` | 50px inputs, 14px radius, gold focus ring |
| `.chip` + `.chip-add` | `ChipInput` | ICP editor |
| `.steps` rail | `Rail` / `StepList` | onboarding progress and app navigation |
| `.rail-mob` | `MobileRail` | sticky top bar under 860px |
| `.ob-foot` | `StickyFooter` | sticky action bar |
| `.ob-kicker`, `.ob-h`, `.ob-p` | `ViewHeader` | kicker, headline with optional gold span, lede |
| `.stats3` / `.stat` / `.big` / `.sub` | `StatGrid`, `Stat` | KPI rows |
| `.track` | `Meter` | progress bars |
| `.scan-row` (run/done) | `ProgressRow` | agent log and provisioning |
| `.agent` + `.orb` | `AgentCard` | long-running AI work |
| `.notice` | `Notice` (`tone`) | warnings and banners |
| `.mail` tabs/head/body + `.tok` | `EmailPreview` | sequence preview, thread messages |
| `.plan` | `PlanCard` | plan picker |
| `.dtile` | `DomainTile` | domain picker |
| `.ibx` rows + `.stepper` + `.addr` | `InboxTable`, `Stepper` | inbox allocation |
| `.timeline` | `Timeline` | billing / setup timeline |
| `.state-pill`, `.live` + `.pulse` | `StatePill` | live / warm / paused states |
| `.chip-s` (`g`,`b`,`v`,`y`) | `Badge` (`tone`) | reply classes, statuses |
| `.dns table` | `DataTable` | every tabular list (sticky header, mono cells) |
| `.reply` | `ReplyItem` | conversation list rows |
| `.qa` details | `Faq` | marketing |
| `.spinner` | `Spinner` | inline loading |

Added for the app (built from the same tokens, no new colours): `Modal`/`Drawer` (glass panel over a
`rgba(10,9,8,.6)` scrim), `Toast` (glass pill, bottom-right, tone dot), `Skeleton` (shimmering
`rgba(255,240,220,.05)` block), `EmptyState`, `ErrorState` (message + Retry), `Pagination`.

## Layout

* Marketing: centred `.wrap` = `min(1180px, 100% - 32px)`; floating glass nav pill.
* Onboarding and the app share the source's three-column shell: `268px rail | content | 320px aside`,
  collapsing to `248px | content` under 1240px (aside content moves inline), and to one column with the
  mobile rail under 860px.
* Admin reuses the app shell with its own rail items.

## Breakpoints

`1240px` (drop aside), `1020px` (stack two-column grids), `860px` (mobile rail, single column),
`600px` (compact type, stacked stats). Tailwind screens are configured with these exact values.

## Motion

`viewIn` (.6s rise-in for each view), `drop` (list items), `spin` (the conic orb), `pulse` (live dot),
`rot` (spinner), glass specular on pointer move. All disabled under `prefers-reduced-motion`.

## Iconography

The source's SVG sprite (`i-arr`, `i-check`, `i-globe`, `i-shield`, `i-key`, `i-flame`, `i-rotate`,
`i-plus`, `i-minus`, `i-x`, `i-lock`, `i-inbox`, `i-alert`, `i-back`, `i-plane`, `i-sparkle`, `i-chev`,
`i-pin`, `i-at`, `i-search`) is reproduced as an `Icon` component with the same stroke weights, plus a few
app icons drawn in the same style (dashboard, users, ban, activity, gear, card, logout).

## Not carried over

The WebGL liquid-glass hero pane and glacier mesh are decorative and depend on Chromium-only SVG backdrop
filters; the source itself falls back to the CSS glass on other engines. The rebuild uses that CSS glass
everywhere, which keeps the bundle small and the look consistent across browsers.
