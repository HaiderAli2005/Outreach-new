"use client";

import { Select } from "@/components/ui/Select";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Avatar, Button, Chip, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { useToast } from "@/store";
import {
  errorMessage,
  useCorrectIntentMutation,
  useDealClosedMutation,
  useDiscardDraftMutation,
  useInboxQuery,
  useMarkHandledMutation,
  useRemoveConversationMutation,
  useReplyMutation,
  useStopSequenceMutation,
  useThreadQuery,
  useVocabQuery,
} from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, clock, dateTime, n0 } from "@/lib/format";
import type { InboxRow, Thread as ThreadData, ThreadMessage, VocabItem } from "@/lib/types";

type Tone = "g" | "b" | "v" | "y" | "r";
const toneOf = (c: string | null | undefined): Tone => (c && ["g", "b", "v", "y", "r"].includes(c) ? (c as Tone) : "v");

const STOP_REASON: Record<string, string> = {
  replied: "they replied",
  colleague_replied: "a colleague at their company replied",
  unsubscribed: "they unsubscribed",
  bounced: "the address bounced",
  complained: "they marked it as spam",
  hostile: "they replied angrily",
  manual: "you marked them done",
  finished: "all four emails went",
};

/** The status a person shows with: your correction if you made one, else the model's read of their reply. */
function statusOf(key: string | null | undefined, vocab: VocabItem[] | undefined) {
  if (!key) return null;
  const v = vocab?.find((x) => x.key === key);
  return { key, label: v?.label ?? key.toLowerCase().replace(/_/g, " "), tone: toneOf(v?.color) };
}

const FILTERS = [
  ["all", "All"],
  ["needs", "Needs reply"],
  ["replied", "Handled"],
  ["sent", "Sent only"],
] as const;

const REPLY_FILTERS = ["urgent", "lead", "hot", "question", "review", "curious", "not_now", "away", "moved", "auto"];

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

const Dots = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <circle cx="5" cy="12" r="1.7" fill="currentColor" />
    <circle cx="12" cy="12" r="1.7" fill="currentColor" />
    <circle cx="19" cy="12" r="1.7" fill="currentColor" />
  </svg>
);
const InfoIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" strokeLinecap="round" />
    <circle cx="12" cy="8" r=".6" fill="currentColor" />
  </svg>
);

function oneLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * One email in the thread, the way a mail client lists it: avatar, a single line with the sender, their address and
 * the date, and the text underneath. The newest is open; older ones show their first line only and open on click.
 */
function Message({ m, data, open, onToggle, toggleable }: { m: ThreadMessage; data: ThreadData; open: boolean; onToggle: () => void; toggleable: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const c = data.contact;
  const out = m.direction === "OUTBOUND";
  const auto = out && m.via === "auto-reply";
  const them = c.fullName ?? c.email;
  const us = data.email.fromName ?? "You";
  const who = out ? us : them;
  const addr = out ? data.email.fromCompany : c.email;

  const head = (
    <span className="ibx-m-line">
      <b>{auto ? "Automatic reply" : who}</b>
      {addr ? <span className="ibx-addr">{addr}</span> : null}
      <time dateTime={m.createdAt}>{dateTime(m.createdAt)}</time>
    </span>
  );

  if (!open) {
    return (
      <button type="button" className="ibx-m folded" onClick={onToggle} aria-expanded={false}>
        <Avatar name={who} url={out ? null : c.photoUrl} size={32} />
        <span className="ibx-m-main">
          {head}
          <span className="ibx-m-snip" dir="auto">
            {oneLine(m.body)}
          </span>
        </span>
      </button>
    );
  }

  const Head = toggleable ? "button" : "div";
  return (
    <article className="ibx-m">
      <Avatar name={who} url={out ? null : c.photoUrl} size={32} />
      <div className="ibx-m-main">
        <Head {...(toggleable ? { type: "button" as const, onClick: onToggle, "aria-expanded": true } : {})} className="ibx-m-head">
          {head}
        </Head>
        <div className="ibx-msg-body" dir="auto">
          {m.body}
        </div>
        {m.quoted ? (
          <>
            <button type="button" className="ibx-quote-btn" onClick={() => setShowQuoted((v) => !v)} aria-expanded={showQuoted} title={showQuoted ? "Hide quoted text" : "Show quoted text"}>
              <Dots />
            </button>
            {showQuoted ? (
              <div className="ibx-quoted" dir="auto">
                {m.quoted}
              </div>
            ) : null}
          </>
        ) : null}
        {m.attachments.length ? (
          <div className="ibx-files">
            {m.attachments.map((a) => (
              <a key={a.url} className="ibx-file" href={a.url} target="_blank" rel="noopener noreferrer">
                <Icon id="download" />
                {a.name}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Thread({ id, onBack, onGone }: { id: string; onBack: () => void; onGone: () => void }) {
  const { data, isLoading, isError, error, refetch } = useThreadQuery(id);
  const [reply, replyState] = useReplyMutation();
  const [handled, handledState] = useMarkHandledMutation();
  const [closed, closedState] = useDealClosedMutation();
  const [remove, removeState] = useRemoveConversationMutation();
  const [discard, discardState] = useDiscardDraftMutation();
  const [correct, correctState] = useCorrectIntentMutation();
  const [stopSeq, stopState] = useStopSequenceMutation();
  const [body, setBody] = useState("");
  const [ask, setAsk] = useState<"closed" | "remove" | null>(null);
  // Emails the person opened or closed by hand; everything else follows the default below.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [sigOpen, setSigOpen] = useState(false);
  const toast = useToast();
  const scroller = useRef<HTMLDivElement | null>(null);
  const latest = useRef<HTMLDivElement | null>(null);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const infoRef = useRef<HTMLDivElement | null>(null);

  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);
  const lastInboundId = useMemo(() => [...messages].reverse().find((m) => m.direction === "INBOUND")?.id, [messages]);
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    setBody(data?.draft?.body ?? "");
  }, [data?.contact.id, data?.draft?.body]);

  // The newest email and their newest reply start open; everything older folds to one line.
  const isOpen = (mid: string) => (mid === lastId || mid === lastInboundId) !== flipped.has(mid);

  // Land on the newest email, right above the reply box, the way a mail client opens a thread.
  useLayoutEffect(() => {
    const el = latest.current;
    const box = scroller.current;
    if (!el || !box) return;
    box.scrollTop = Math.max(0, el.offsetTop - box.offsetTop - 12);
  }, [data?.contact.id, lastId]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
  }, [body]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  useEffect(() => {
    if (!info) return;
    // The status menu renders in a portal, so a click in it counts as "inside" too.
    const inside = (t: EventTarget | null) => (t instanceof Node && infoRef.current?.contains(t)) || (t instanceof Element && t.closest(".ui-select-pop"));
    const close = (e: MouseEvent) => !inside(e.target) && setInfo(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".ui-select-pop") && setInfo(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [info]);

  useEffect(() => setInfo(false), [id]);

  if (isError) return <div className="ibx-pad"><ErrorState error={error} onRetry={refetch} /></div>;
  if (isLoading || !data) {
    return (
      <div className="ibx-pad" style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Skeleton h={40} w={40} r={20} />
          <div style={{ flex: 1, display: "grid", gap: 6 }}>
            <Skeleton h={14} w="40%" />
            <Skeleton h={12} w="60%" />
          </div>
        </div>
        <SkeletonRows rows={3} h={80} />
      </div>
    );
  }

  const c = data.contact;
  const name = c.fullName ?? c.email;
  const needsReply = data.messages.at(-1)?.direction === "INBOUND" && !c.handledAt;
  const status = statusOf(data.intent.customer ?? data.intent.model, data.intent.vocab);
  const running = !data.sequence.stoppedAt && c.status === "CONTACTED";
  const locked = !data.canReply && data.replyBlockedReason === "awaiting_their_reply";
  const seqLine = data.sequence.stoppedAt
    ? `Sequence ended: ${STOP_REASON[data.sequence.reason ?? ""] ?? "stopped"}`
    : data.sequence.nextAt
      ? `Next email ${dateTime(data.sequence.nextAt)} in their time`
      : running
        ? "Sequence running"
        : null;

  async function send() {
    if (!body.trim() || locked || !data?.canReply || replyState.isLoading) return;
    try {
      await reply({ id, body }).unwrap();
      toast("Reply sent", "good");
      setBody("");
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  }

  const toggle = (mid: string) =>
    setFlipped((s) => {
      const n = new Set(s);
      if (n.has(mid)) n.delete(mid);
      else n.add(mid);
      return n;
    });

  // Long threads fold their middle into "N earlier emails", keeping the first and the most recent in view.
  const n = messages.length;
  const middle = messages.map((m, i) => ({ m, i })).filter(({ m, i }) => i > 0 && i < n - 2 && !isOpen(m.id));
  const fold = !showAll && middle.length >= 2;
  const hidden = new Set(fold ? middle.map(({ m }) => m.id) : []);

  const details = (
    <>
      <div className="ibx-info-sec">
        <h4>Contact</h4>
        <dl>
          <div>
            <dt>Email</dt>
            <dd className="mono">
              <a href={`mailto:${c.email}`}>{c.email}</a>
            </dd>
          </div>
          {c.title ? (
            <div>
              <dt>Title</dt>
              <dd>{c.title}</dd>
            </div>
          ) : null}
          {c.company ? (
            <div>
              <dt>Company</dt>
              <dd>{c.company}</dd>
            </div>
          ) : null}
          {c.location ? (
            <div>
              <dt>Location</dt>
              <dd>{c.location}</dd>
            </div>
          ) : null}
          {c.emailSource ? (
            <div>
              <dt>Found via</dt>
              <dd>
                {c.emailSource}
                {c.verifyResult ? ` · ${c.verifyResult === "ok" ? "valid" : c.verifyResult}` : ""}
              </dd>
            </div>
          ) : null}
          {c.linkedinUrl ? (
            <div>
              <dt>LinkedIn</dt>
              <dd>
                <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">
                  Profile
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      {data.intent.model ? (
        <div className="ibx-info-sec">
          <h4>Status</h4>
          <Select
            className="select ibx-status"
            aria-label="Status"
            value={data.intent.customer ?? data.intent.model}
            disabled={correctState.isLoading}
            onChange={(e) =>
              correct({ id, intent: e.target.value })
                .unwrap()
                .then(() => toast("Status updated. Thanks, that helps the sorting get better.", "good"))
                .catch((err) => toast(errorMessage(err), "bad"))
            }
          >
            {data.intent.vocab.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </Select>
          {data.intent.customer && data.intent.customer !== data.intent.model ? <p className="ibx-info-note">You changed this from the automatic read.</p> : null}
        </div>
      ) : null}
      <div className="ibx-info-sec">
        <h4>Outreach</h4>
        <dl>
          {data.campaign ? (
            <div>
              <dt>Campaign</dt>
              <dd>{data.campaign.name}</dd>
            </div>
          ) : null}
          {data.email.fromName ? (
            <div>
              <dt>Sent from</dt>
              <dd>{data.email.fromName}</dd>
            </div>
          ) : null}
          {data.email.sentAt ? (
            <div>
              <dt>First email</dt>
              <dd>{dateTime(data.email.sentAt)}</dd>
            </div>
          ) : null}
          {seqLine ? (
            <div>
              <dt>Sequence</dt>
              <dd>{seqLine.replace(/^Sequence /, "").replace(/^ended: /, "Ended: ").replace(/^running$/, "Running")}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </>
  );

  return (
    <div className="ibx-th">
      <div className="ibx-th-main">
        <header className="ibx-th-head">
          <button className="ibx-icon-btn back-to-list" type="button" onClick={onBack} aria-label="All conversations">
            <Icon id="back" />
          </button>
          <Avatar name={name} url={c.photoUrl} size={40} />
          <div className="ibx-th-who">
            <div className="ibx-th-name">
              <b>{name}</b>
              {status ? <Chip tone={status.tone}>{status.label}</Chip> : c.replyClass ? <Chip tone={REPLY_TONE[c.replyClass] ?? "v"}>{REPLY_LABEL[c.replyClass] ?? c.replyClass}</Chip> : null}
              {c.replyUrgent ? <Chip tone="r">Urgent</Chip> : null}
            </div>
            <div className="ibx-th-sub">{[c.title, c.company].filter(Boolean).join(" at ") || c.email}</div>
          </div>
          <div className="ibx-th-actions">
            {needsReply ? (
              <Button
                size="xs"
                icon="check"
                loading={handledState.isLoading}
                title="Moves it out of Needs reply. Sends nothing. It comes back if they write again."
                onClick={() => handled(id).unwrap().then(() => toast("Moved out of Needs reply. It comes back if they write again.", "good")).catch((e) => toast(errorMessage(e), "bad"))}
              >
                No reply needed
              </Button>
            ) : null}
            {running ? (
              <Button
                size="xs"
                loading={stopState.isLoading}
                title="Stops the follow-up emails still scheduled for them. You can still reply yourself."
                onClick={() => stopSeq(id).unwrap().then(() => toast("Follow-ups stopped. No more automatic emails go to them.", "good")).catch((e) => toast(errorMessage(e), "bad"))}
              >
                Stop follow-ups
              </Button>
            ) : null}
            <Button size="xs" className="hide-sm" title="They're a customer now. Blocks their company from cold email; you can still reply." onClick={() => setAsk("closed")}>
              Won: stop outreach
            </Button>
            <div className="ibx-menu" ref={infoRef}>
              <button type="button" className={`ibx-info-btn${info ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={info} onClick={() => setInfo((v) => !v)} title="Contact details">
                <InfoIcon />
                <span>Info</span>
              </button>
              {info ? (
                <div className="ibx-info-pop" role="dialog" aria-label="Contact details">
                  {details}
                </div>
              ) : null}
            </div>
            <div className="ibx-menu" ref={menuRef}>
              <button type="button" className="ibx-icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
                <Dots />
              </button>
              {menu ? (
                <div className="ibx-menu-pop" role="menu">
                  {/* Phones only: there the header has no room for the button, so it lives here instead. */}
                  <button type="button" role="menuitem" className="only-sm" onClick={() => (setMenu(false), setAsk("closed"))}>
                    Won: stop outreach
                  </button>
                  <button type="button" role="menuitem" className="bad" onClick={() => (setMenu(false), setAsk("remove"))}>
                    Remove and block
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="ibx-scroll" ref={scroller}>
          <div className="ibx-subject">
            <h2 dir="auto">{data.email.subject || "(no subject)"}</h2>
            <span>
              {n} {n === 1 ? "email" : "emails"}
              {data.campaign ? ` · ${data.campaign.name}` : ""}
            </span>
          </div>
          <div className="ibx-msgs">
            {messages.map((m, i) => {
              if (hidden.has(m.id)) {
                return middle[0].m.id === m.id ? (
                  <button key="fold" type="button" className="ibx-fold" onClick={() => setShowAll(true)}>
                    {middle.length} earlier emails
                  </button>
                ) : null;
              }
              return (
                <div key={m.id} ref={m.id === lastId ? latest : undefined}>
                  <Message m={m} data={data} open={isOpen(m.id)} toggleable={i !== n - 1} onToggle={() => toggle(m.id)} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="ibx-composer">
          {locked ? (
            <div className="ibx-locked">
              <Icon id="lock" />
              <span>You&apos;ve sent your one message into this thread. It opens again as soon as they reply: extra messages to someone who hasn&apos;t answered are what get senders reported.</span>
            </div>
          ) : (
            <div className={`ibx-compose${data.draft ? " has-draft" : ""}`}>
              <div className="ibx-compose-top">
                <span className="to">
                  Reply to <b>{c.firstName ?? name}</b>
                  {data.email.fromName ? <span className="muted"> from {data.email.fromName}</span> : null}
                </span>
                {data.draft ? (
                  <span className="ibx-ai">
                    <Icon id="sparkle" />
                    Drafted for you
                    <button
                      type="button"
                      className="ibx-link"
                      disabled={discardState.isLoading}
                      onClick={() =>
                        discard(id)
                          .unwrap()
                          .then(() => (setBody(""), toast("Draft discarded", "good")))
                          .catch((e) => toast(errorMessage(e), "bad"))
                      }
                    >
                      Discard
                    </button>
                  </span>
                ) : null}
              </div>
              <label className="sr" htmlFor="replyBody">
                Reply
              </label>
              <textarea
                id="replyBody"
                ref={ta}
                dir="auto"
                className="ibx-ta"
                rows={2}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                maxLength={10000}
                placeholder={`Write your reply to ${c.firstName ?? name}…`}
              />
              {data.email.signature ? (
                <button type="button" className={`ibx-sig${sigOpen ? " open" : ""}`} onClick={() => setSigOpen((v) => !v)} aria-expanded={sigOpen} title="Added under your reply">
                  {sigOpen ? data.email.signature : data.email.signature.split("\n").filter(Boolean).join(" · ")}
                </button>
              ) : null}
              <div className="ibx-compose-foot">
                <span className="hint">
                  {data.coldMessageLeft ? "They haven't replied yet: you can send one message, then the thread waits for them." : data.draft ? "Never sent on its own. Edit, then send." : "Sent from the inbox that emailed them."}
                  <kbd>Ctrl</kbd>
                  <kbd>Enter</kbd>
                </span>
                <Button variant="primary" size="sm" icon="plane" loading={replyState.isLoading} disabled={!body.trim() || !data.canReply} onClick={send}>
                  Send
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {ask === "closed" ? (
        <Confirm
          title={`Won ${c.fullName ?? c.email}? Stop all outreach to them`}
          confirmLabel="Won: stop outreach"
          loading={closedState.isLoading}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            closed(id)
              .unwrap()
              .then((r) => {
                setAsk(null);
                toast(`${r.name} is marked as won. No cold email goes to them or their company again.`, "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body={
            c.company
              ? `Their email and ${c.company}'s domain go on your blocklist, so no cold email reaches them or their colleagues again, and their follow-ups stop. You can still reply to them here. To undo it, remove them on the Suppress list page.`
              : "Their email goes on your blocklist, so no cold email reaches them again, and their follow-ups stop. You can still reply to them here. To undo it, remove them on the Suppress list page."
          }
        />
      ) : null}
      {ask === "remove" ? (
        <Confirm
          title="Remove this conversation?"
          danger
          confirmLabel="Remove and block"
          loading={removeState.isLoading}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            remove(id)
              .unwrap()
              .then((r) => {
                setAsk(null);
                toast(`${r.name} removed and ${r.blocked} blocked`, "good");
                onGone();
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="The conversation leaves your inbox and the address is added to your blocklist. You can restore it from the blocklist."
        />
      ) : null}
    </div>
  );
}

function Row({ r, vocab, active, onOpen }: { r: InboxRow; vocab: VocabItem[] | undefined; active: boolean; onOpen: () => void }) {
  const st = statusOf(r.leadStatus, vocab);
  return (
    <button type="button" className={`ibx-row${r.needsReply ? " is-unread" : ""}`} aria-current={active} onClick={onOpen} data-row={r.id}>
      <Avatar name={r.fullName ?? r.email} url={r.photoUrl} size={36} />
      <div className="ibx-row-main">
        <div className="ibx-row-top">
          <b>{r.fullName ?? r.email}</b>
          <time dateTime={r.lastMessageAt ?? undefined}>{ago(r.lastMessageAt)}</time>
        </div>
        {r.company ? <div className="ibx-row-co">{r.company}</div> : null}
        <p dir="auto">
          {r.lastMessageDirection === "OUTBOUND" ? <span className="you">You: </span> : null}
          {r.lastMessagePreview}
        </p>
        {r.replyUrgent || st || r.replyClass || r.hasDraft ? (
          <div className="ibx-row-tags">
            {r.replyUrgent ? <span className="chip-s r">Urgent</span> : null}
            {st ? <span className={`chip-s ${st.tone}`}>{st.label}</span> : r.replyClass ? <span className={`chip-s ${REPLY_TONE[r.replyClass] ?? "v"}`}>{REPLY_LABEL[r.replyClass] ?? r.replyClass}</span> : null}
            {r.hasDraft ? (
              <span className="chip-s b">
                <Icon id="sparkle" />
                Draft ready
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {r.needsReply ? <span className="unread" aria-label="Needs reply" /> : null}
    </button>
  );
}

type MenuOption = { value: string; label: string; count?: number };

/** The reply-type filter: a themed menu instead of the browser's own select list. */
function ReplyTypeMenu({ value, options, onChange }: { value: string; options: MenuOption[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    btn.current?.focus();
  };
  const show = () => {
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  return (
    <div className="ibx-dd" ref={box}>
      <button
        ref={btn}
        type="button"
        className={`ibx-dd-btn${value ? " set" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Reply type"
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            show();
          } else if (open) {
            if (e.key === "Escape") (e.preventDefault(), setOpen(false));
            else if (e.key === "ArrowDown") (e.preventDefault(), setHi((i) => Math.min(options.length - 1, i + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi((i) => Math.max(0, i - 1)));
            else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), pick(options[hi].value));
          }
        }}
      >
        <span>{current.label}</span>
        {current.count ? <span className="ibx-count">{current.count}</span> : null}
        <Icon id="chev" className="ibx-dd-chev" />
      </button>
      {open ? (
        <div className="ibx-dd-pop" role="listbox" aria-label="Reply type">
          {options.map((o, i) => (
            <button
              key={o.value || "all"}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={i === hi ? "hi" : undefined}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.value)}
            >
              <span className="ck">{o.value === value ? <Icon id="check" /> : null}</span>
              <span className="lb">{o.label}</span>
              {o.count ? <span className="n">{o.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const filter = params.get("filter") ?? "all";
  const reply = params.get("reply") ?? undefined;
  const selected = params.get("c");
  // 50 a page, more loaded as the list scrolls. The first page is polled so new replies show up.
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<Record<number, InboxRow[]>>({});
  const listKey = `${filter}|${reply ?? ""}`;
  useEffect(() => {
    setPage(1);
    setPages({});
  }, [listKey]);
  const { data, isLoading, isFetching, isError, error, refetch } = useInboxQuery({ filter, reply, page }, { pollingInterval: page === 1 ? 60_000 : 0, skipPollingIfUnfocused: true });
  const { data: vocab } = useVocabQuery();
  useEffect(() => {
    if (data) setPages((p) => ({ ...p, [page]: data.data }));
  }, [data, page]);
  const rows = useMemo(() => Object.keys(pages).map(Number).sort((a, b) => a - b).flatMap((k) => pages[k]).filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i), [pages]);
  const total = data?.meta.total ?? 0;
  const more = rows.length < total;
  const sentinel = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetching) setPage((p) => p + 1);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more, isFetching, rows.length]);

  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    router.replace(`${path}?${p.toString()}`, { scroll: false });
  };

  // j / k (or the arrow keys) move through conversations; Escape closes the open one on small screens.
  const nav = useRef({ rows, selected, setParam });
  useEffect(() => {
    nav.current = { rows, selected, setParam };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const { rows: list, selected: cur, setParam: go } = nav.current;
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (!down && !up) return;
      if (!list.length) return;
      e.preventDefault();
      const i = list.findIndex((r) => r.id === cur);
      const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
      if (next && next.id !== cur) {
        go({ c: next.id });
        listRef.current?.querySelector(`[data-row="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = data?.meta.counts;

  return (
    <div className="ibx">
      <div className="ibx-top">
        <div className="ibx-title">
          <h1>Inbox</h1>
          <p>Every reply to your outreach, the ones that need you first.</p>
        </div>
        <div className="ibx-tools">
          <div className="ibx-tabs" role="tablist" aria-label="Filter conversations">
            {FILTERS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setParam({ filter: k })}>
                {l}
                {counts ? <span className={`ibx-count${k === "needs" && counts.needs ? " hot" : ""}`}>{n0(counts[k])}</span> : null}
              </button>
            ))}
          </div>
          <ReplyTypeMenu
            value={reply ?? ""}
            onChange={(v) => setParam({ reply: v || null })}
            options={[
              { value: "", label: "All reply types" },
              ...REPLY_FILTERS.map((r) => ({
                value: r,
                label: r === "urgent" ? "Urgent" : r === "lead" ? "Leads (interested)" : REPLY_LABEL[r] ?? r,
                count: r === "urgent" ? counts?.urgent : r === "lead" ? undefined : counts?.byClass[r],
              })),
            ]}
          />
        </div>
      </div>

      <div className={`ibx-grid${selected ? " has-thread" : ""}`}>
        <aside className="ibx-list" aria-label="Conversations">
          <div className="ibx-list-head">
            <span>
              {data ? `${n0(total)} ${total === 1 ? "conversation" : "conversations"}` : "Conversations"}
            </span>
            {isFetching && !isLoading ? <span className="spinner" style={{ width: 14, height: 14, borderColor: "rgba(255,240,220,.2)", borderTopColor: "var(--gold)" }} /> : <span className="ibx-keys"><kbd>J</kbd><kbd>K</kbd> to move</span>}
          </div>
          <div className="ibx-list-scroll" ref={listRef}>
            {isError ? (
              <div className="ibx-pad">
                <ErrorState error={error} onRetry={refetch} />
              </div>
            ) : (isLoading || !data) && !rows.length ? (
              <div className="ibx-pad">
                <SkeletonRows rows={7} h={58} />
              </div>
            ) : !rows.length ? (
              <Empty icon="inbox" title={filter === "needs" ? "You're all caught up" : "No conversations here"}>
                {filter === "needs" ? "Nobody is waiting on a reply from you." : "Conversations appear once emails go out and people answer."}
              </Empty>
            ) : (
              <>
                {rows.map((r) => (
                  <Row key={r.id} r={r} vocab={vocab} active={selected === r.id} onOpen={() => setParam({ c: r.id })} />
                ))}
                {more ? (
                  <div ref={sentinel} className="list-more">
                    {isFetching ? <span className="spinner" /> : <button type="button" className="btn btn-text btn-sm" onClick={() => setPage((p) => p + 1)}>Load more</button>}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
        <section className="ibx-pane">
          {selected ? (
            <Thread key={selected} id={selected} onBack={() => setParam({ c: null })} onGone={() => setParam({ c: null })} />
          ) : (
            <div className="ibx-empty">
              <Empty icon="inbox" title="Pick a conversation">
                The full thread, a drafted reply and the contact&apos;s details show up here. Use <kbd>J</kbd> and <kbd>K</kbd> to move through the list.
              </Empty>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="ibx">
          <SkeletonRows rows={6} />
        </div>
      }
    >
      <Inbox />
    </Suspense>
  );
}
