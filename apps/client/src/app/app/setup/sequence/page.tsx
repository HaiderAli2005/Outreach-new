"use client";

import { useEffect, useState } from "react";
import { Button, Empty, ErrorState, Notice, SkeletonRows, TextArea, TextField, ViewHead } from "@/components/ui/primitives";
import { useRole, useToast } from "@/store";
import { errorMessage, useSaveSequenceMutation, useSequenceQuery } from "@/store/api";
import type { SequenceTouch } from "@/lib/types";

const NAMES = ["First email", "Follow-up", "Another angle", "Last note"];

/** Counts the way the server checks: merge fields count as one word; the greeting line is not a paragraph. */
function firstStats(body: string) {
  const words = body.replace(/\{\{[^}]+\}\}/g, "Name").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const parts = body.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(hi|hello|hey|dear)\b[^\n]{0,60},?$/i.test(parts[0])) parts.shift();
  const questions = (body.match(/\?/g) ?? []).length;
  return { words, paragraphs: parts.length, questions };
}

type FieldError = { step: number; field: "subject" | "body"; message: string };

/**
 * Setup > Email sequence. The campaign's 4 emails (days 0, 3, 7, 14). Every prospect's emails are written from
 * these: the AI keeps each email's structure, offer, proof and question, and fills in the prospect. The template
 * rules are checked when you save.
 */
export default function SequencePage() {
  const { data, isLoading, isError, error, refetch } = useSequenceQuery();
  const [save, { isLoading: saving }] = useSaveSequenceMutation();
  const { canManage } = useRole();
  const toast = useToast();
  const [touches, setTouches] = useState<SequenceTouch[] | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  useEffect(() => {
    if (data) setTouches(data.touches);
  }, [data]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data || !touches) return <SkeletonRows rows={4} h={140} />;
  if (!data.campaignId)
    return (
      <>
        <ViewHead kicker="Setup" title="Email sequence" />
        <Empty icon="st-mail" title="No campaign yet">
          Your sequence appears here once setup has created your campaign.
        </Empty>
      </>
    );

  const set = (i: number, p: Partial<SequenceTouch>) => {
    setErrors((e) => e.filter((x) => x.step !== i + 1));
    setTouches((t) => (t ? t.map((x, k) => (k === i ? { ...x, ...p } : x)) : t));
  };
  const dirty = JSON.stringify(touches) !== JSON.stringify(data.touches) || data.fromSample;
  const err = (step: number, field: "subject" | "body") => errors.filter((e) => e.step === step && e.field === field).map((e) => e.message).join(" ") || null;
  const s1 = firstStats(touches[0].body);
  const subject = touches[0].subject ?? "";

  return (
    <>
      <ViewHead kicker="Setup" title="Email sequence" sub="Four emails over two weeks. Each prospect gets their own version: the AI keeps your structure, offer, proof and question, and writes the opening about their company." />
      {data.fromSample ? (
        <Notice tone="info" icon="st-mail" title="This is the sequence from your setup">
          Edit it if you like, then save to make it your campaign&apos;s sequence. Until then, emails are written from your business profile.
        </Notice>
      ) : null}
      <p className="fine">
        Merge fields: <code>{"{{first_name}}"}</code>, <code>{"{{company}}"}</code> and <code>{"{{sender_first_name}}"}</code> (the name of the mailbox it goes out from).
      </p>
      <fieldset disabled={!canManage} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        {touches.map((t, i) => (
          <div className="panel glass seq-touch" key={t.step}>
            <h3>
              {NAMES[i]}
              <small>day {t.day}</small>
            </h3>
            <div className="stack" style={{ marginTop: 12 }}>
              {i === 0 ? (
                <TextField label="Subject" value={subject} maxLength={120} onChange={(e) => set(0, { subject: e.target.value })} error={err(1, "subject")} hint="2 to 4 words about their world, a noun phrase with no verb. For example: Client reporting time." />
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                  Sent as a reply in the same thread: <b>Re: {subject || "your subject"}</b>
                </p>
              )}
              <TextArea label={i === 0 ? "Email" : "Reply"} rows={i === 0 ? 12 : 5} maxLength={4000} value={t.body} onChange={(e) => set(i, { body: e.target.value })} error={err(i + 1, "body")} />
              {i === 0 ? (
                <p className="seq-rules">
                  <span className={s1.words >= 90 && s1.words <= 130 ? "ok" : "off"}>{s1.words} words (90 to 130)</span>
                  <span className={s1.paragraphs === 4 ? "ok" : "off"}>{s1.paragraphs} paragraphs (4)</span>
                  <span className={s1.questions === 1 ? "ok" : "off"}>
                    {s1.questions} question{s1.questions === 1 ? "" : "s"} (1, at the end)
                  </span>
                </p>
              ) : (
                <p className="seq-rules">
                  <span className={(t.body.match(/\?/g) ?? []).length <= 1 ? "ok" : "off"}>At most one question</span>
                </p>
              )}
            </div>
          </div>
        ))}
      </fieldset>
      {canManage ? (
        <div className="ob-foot glass" style={{ marginTop: 4 }}>
          <span className="spacer muted" style={{ fontSize: 14 }}>
            Saved changes apply to every email written from now on. Emails already approved stay as they are.
          </span>
          {dirty && !data.fromSample ? (
            <Button variant="text" onClick={() => (setTouches(data.touches), setErrors([]))}>
              Discard
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty}
            onClick={() =>
              save({ touches: touches.map((t) => ({ subject: t.subject, body: t.body })) })
                .unwrap()
                .then(() => (setErrors([]), toast("Sequence saved", "good")))
                .catch((e) => {
                  const list = (e?.data?.error?.details?.errors ?? []) as FieldError[];
                  setErrors(list);
                  toast(list.length ? "Fix the highlighted parts, then save again." : errorMessage(e), "bad");
                })
            }
          >
            Save sequence
          </Button>
        </div>
      ) : null}
    </>
  );
}
