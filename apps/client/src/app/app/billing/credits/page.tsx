"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Chip, Empty, ErrorState, Notice, Pager, SkeletonRows, StatePill, ViewHead } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { useAppSelector, useRole, useToast } from "@/store";
import { errorMessage, useCloseAccountMutation, useCreditsQuery, useOrganizationQuery, usePaymentsQuery, usePlansQuery, useRemoveCardMutation, useReverifyMutation } from "@/store/api";
import { ActivityTable } from "@/components/billing/Credits";
import { DailyBudget, PRICE_COPY, TopupChooser } from "@/components/billing/DailyBudget";
import { AutoReload } from "@/components/billing/AutoReload";
import { parseDollars, usd } from "@/components/onboarding/sizing";
import { CardSetupForm, ConfirmAutoReload, TopupPay, type PayHandle } from "@/components/onboarding/Payment";
import { dateLong, money, n0, titleCase } from "@/lib/format";

const PAY_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = { SUCCEEDED: "g", PROCESSING: "b", REQUIRES_PAYMENT: "y", FAILED: "r", REFUNDED: "v", PARTIALLY_REFUNDED: "v" };
const HEALTH_TONE = { OK: "go", WARNING: "warm", PAUSED: "bad" } as const;

function CloseAccount({ onClose }: { onClose: () => void }) {
  const { data: org } = useOrganizationQuery();
  const [close, { isLoading }] = useCloseAccountMutation();
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const toast = useToast();
  const router = useRouter();
  return (
    <Modal
      title="Close your account"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-text btn-sm" onClick={onClose}>
            Keep my account
          </button>
          <Button
            variant="primary"
            size="sm"
            loading={isLoading}
            disabled={!org || confirm.trim().toLowerCase() !== org.name.trim().toLowerCase()}
            onClick={() =>
              close({ confirm })
                .unwrap()
                .then(() => {
                  toast("Your account is closed.", "good");
                  router.push("/");
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Close account
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>Sending stops, money held for queued emails goes back to your balance, and your saved card is removed. Conversations stay readable.</p>
      <label className="au-field" htmlFor="closeConfirm" style={{ display: "grid", gap: 6, marginTop: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Type <b>{org?.name ?? "your workspace name"}</b> to confirm
        </span>
        <input id="closeConfirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </label>
      {err ? (
        <p className="au-err" role="alert">
          {err}
        </p>
      ) : null}
    </Modal>
  );
}

function CreditsPage() {
  const params = useSearchParams();
  const { canManage } = useRole();
  const toast = useToast();
  const orgId = useAppSelector((s) => s.auth.activeOrgId) ?? "";
  const [awaiting, setAwaiting] = useState(params.get("paid") === "1");
  const [slow, setSlow] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(params.get("confirm"));
  const { data, isLoading, isError, error, refetch } = useCreditsQuery(undefined, { refetchOnMountOrArgChange: true, pollingInterval: awaiting ? 2500 : 0 });
  const { data: cat } = usePlansQuery();
  const [payPage, setPayPage] = useState(1);
  const { data: payments, isLoading: payLoading } = usePaymentsQuery({ page: payPage });
  const card = useRef<PayHandle | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardSaved, setCardSaved] = useState(params.get("card") === "1");
  const [removeCard, removing] = useRemoveCardMutation();
  const [reverify, reverifying] = useReverifyMutation();
  const [amount, setAmount] = useState("");
  const [paying, setPaying] = useState(false);
  const [closing, setClosing] = useState(false);
  const before = useRef<string | null>(null);

  const registerCard = useCallback((h: PayHandle | null) => {
    card.current = h;
    setCardReady(!!h);
  }, []);
  // Saved in the page; Stripe tells the server, which adds the free credit. Poll until the card shows as saved.
  const onCardSaved = useCallback(() => setCardSaved(true), []);
  useEffect(() => {
    if (!cardSaved || data?.hasCard) return;
    const t = setInterval(() => refetch(), 2500);
    const stop = setTimeout(() => clearInterval(t), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [cardSaved, data?.hasCard, refetch]);
  useEffect(() => {
    if (cardSaved && data?.hasCard) setCardSaved(false);
  }, [cardSaved, data?.hasCard]);
  const onPaid = useCallback(() => {
    setPaying(false);
    setAwaiting(true);
  }, []);

  // The balance moves when Stripe confirms the payment to the server. Until then, poll.
  useEffect(() => {
    if (!data) return;
    if (!awaiting) {
      before.current = data.balanceDeciCents;
      return;
    }
    before.current ??= "0";
    if (BigInt(data.balanceDeciCents) > BigInt(before.current)) {
      setAwaiting(false);
      setSlow(false);
      toast(`Credits added. Your balance is ${data.balance}.`, "good");
    }
  }, [awaiting, data, toast]);
  useEffect(() => {
    if (!awaiting) return;
    setSlow(false);
    // Stripe normally confirms within seconds. If it hasn't after two minutes the payment is still safe: the hourly
    // sync credits it, so this says so instead of showing an error.
    const t = setTimeout(() => {
      setAwaiting(false);
      setSlow(true);
    }, 120_000);
    return () => clearTimeout(t);
  }, [awaiting]);

  const budget = data?.dailyBudget && data.dailyBudget !== "0" ? data.dailyBudget : (cat?.budget.defaultDeciCents ?? "0");

  return (
    <>
      <ViewHead
        kicker="Credits"
        title="Pay per email."
        sub={cat ? PRICE_COPY(cat) : ""}
      />
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !data ? (
        <SkeletonRows rows={3} h={80} />
      ) : (
        <>
          {awaiting ? (
            <Notice tone="info" icon="card" title="Payment submitted">
              Waiting for Stripe to confirm it. This usually takes a few seconds.
            </Notice>
          ) : slow ? (
            <Notice tone="info" icon="card" title="This is taking longer than usual">
              Your payment is safe. The credits appear here as soon as Stripe confirms it, at the latest within the hour.
            </Notice>
          ) : null}
          {confirmId && canManage ? (
            <ConfirmAutoReload
              paymentIntentId={confirmId}
              onClose={() => setConfirmId(null)}
              onDone={() => {
                setConfirmId(null);
                setAwaiting(true);
              }}
            />
          ) : null}

          <div className="engine glass cr-top">
            <div style={{ display: "grid", gap: 6 }}>
              <small className="muted">Balance</small>
              <b className="bal-big">{data.balance}</b>
              <span className="muted" style={{ fontSize: 14 }}>
                {data.lasts ? `You have ${data.balance} left, ${data.lasts} at your daily budget.` : `About ${n0(data.emailsLeft)} emails.`}
                {data.held !== "$0.00" ? ` ${data.held} is held for follow-ups already scheduled.` : ""}
              </span>
              <span className="cr-promise">Run out of credit and your cold email pauses. Your live conversations don&apos;t.</span>
            </div>
            <div className="kvgrid kv3" style={{ minWidth: 260, flex: "0 1 520px" }}>
              <div>
                <small>Daily budget</small>
                <b>{data.dailyBudget === null ? "No cap" : data.dailyBudget === "0" ? "Paused" : `${usd(data.dailyBudget)} a day`}</b>
              </div>
              <div>
                <small>Emails left</small>
                <b>{n0(data.emailsLeft)}</b>
              </div>
              <div>
                <small>Per email</small>
                <b>{data.pricePerEmail} an email</b>
              </div>
            </div>
          </div>

          {canManage ? (
            <>
              <div className="section-h" id="card">
                <h2>Your card</h2>
              </div>
              {data.hasCard ? (
                <div className="panel glass cr-acct">
                  <div>
                    <b>{data.card ? `${data.card.brand} ending ${data.card.last4}` : "Card saved"}</b>
                    <p className="muted">It is charged only when you top up, or by auto-reload if you switch it on. Remove it any time.</p>
                  </div>
                  <Button
                    size="sm"
                    loading={removing.isLoading}
                    onClick={() =>
                      removeCard()
                        .unwrap()
                        .then(() => toast("Card removed. Auto-reload is off.", "good"))
                        .catch((e) => toast(errorMessage(e), "bad"))
                    }
                  >
                    Remove card
                  </Button>
                </div>
              ) : (
                <div className="pay">
                  <CardSetupForm orgId={orgId} register={registerCard} onSaved={onCardSaved} onBusy={setCardBusy} returnPath="/app/billing/credits?card=1" />
                  <div className="panel glass">
                    <h3>Add your card</h3>
                    <p style={{ marginTop: 6 }}>
                      {data.trialAvailable && cat
                        ? `Adding a card puts ${cat.pricing.freeTrial.amount} of free credit in your balance, about ${n0(cat.pricing.freeTrial.emails)} emails. Nothing is charged.`
                        : "Save a card for your top-ups. Nothing is charged until you top up."}
                    </p>
                    <Button variant="primary" style={{ marginTop: 14 }} loading={cardBusy} disabled={!cardReady || cardSaved} onClick={() => card.current?.()}>
                      {cardSaved ? "Card saved" : "Save card"}
                    </Button>
                  </div>
                </div>
              )}

              {data.stage !== "unfunded" ? (
                <>
                  <div className="section-h">
                    <h2>Add credits</h2>
                  </div>
                  {cat ? (
                    <TopupChooser
                      cat={cat}
                      budget={budget}
                      amount={amount}
                      onAmount={(a) => {
                        setAmount(a);
                        setPaying(true);
                      }}
                    />
                  ) : null}
                  {paying && amount && !awaiting ? <TopupPay orgId={orgId} amount={amount} card={data.card} onPaid={onPaid} returnPath="/app/billing/credits?paid=1" /> : null}

                  <div className="section-h">
                    <h2>Auto-reload</h2>
                  </div>
                  {cat ? <AutoReload cat={cat} budget={budget} hasCard={data.hasCard} lastTopup={amount || (data.lastTopup ? (parseDollars(data.lastTopup)?.toString() ?? null) : null)} /> : null}
                </>
              ) : null}
            </>
          ) : null}

          <div className="section-h">
            <h2>Daily budget</h2>
          </div>
          <DailyBudget mode="editor" />

          <div className="section-h">
            <h2>Sending health</h2>
          </div>
          <div className="engine glass">
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <b style={{ font: "600 20px var(--f-display)", letterSpacing: "-.02em" }}>Bounce rate {data.health.bounceRate}</b>
                <StatePill tone={HEALTH_TONE[data.health.status]}>{data.health.label}</StatePill>
              </div>
              <span className="muted" style={{ fontSize: 13.5 }}>Last 30 days. Above 2% we warn you; above 4% new emails pause to protect deliverability. Replies to your live conversations carry on.</span>
            </div>
            <div className="kvgrid kv3" style={{ minWidth: 260, flex: "0 1 520px" }}>
              <div>
                <small>Delivered</small>
                <b>{n0(data.health.delivered)}</b>
              </div>
              <div>
                <small>Bounced</small>
                <b>{n0(data.health.bounced)}</b>
              </div>
              <div>
                <small>Replies</small>
                <b>{n0(data.health.replies)}</b>
              </div>
            </div>
          </div>
          {data.health.status === "PAUSED" ? (
            <div className="banner bad" role="alert">
              <span>New emails are paused: {data.health.pausedReason ?? "too many recent emails bounced"}. Re-verify your list to start again.</span>
              {canManage ? (
                <Button
                  size="sm"
                  loading={reverifying.isLoading}
                  onClick={() =>
                    reverify()
                      .unwrap()
                      .then((r) => toast(`Sending restarted. ${n0(r.requeued)} queued people will be checked again first.`, "good"))
                      .catch((e) => toast(errorMessage(e), "bad"))
                  }
                >
                  Re-verify my list
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="section-h">
            <h2>Recent activity</h2>
          </div>
          {data.activity.length ? <ActivityTable rows={data.activity} /> : <Empty icon="list" title="Nothing yet">Top-ups and emails sent show here, a line per day.</Empty>}

          <div className="section-h">
            <h2>Payments</h2>
          </div>
          <div className="tbl-wrap glass">
            {payLoading ? (
              <SkeletonRows rows={3} />
            ) : payments?.data.length ? (
              <>
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Description</th>
                        <th>Status</th>
                        <th className="right">Amount</th>
                        <th className="right">Refunded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.data.map((p) => (
                        <tr key={p.id}>
                          <td className="m">{dateLong(p.createdAt)}</td>
                          <td>
                            {p.description ?? "Credits"}
                            {p.failureMessage ? <div className="m" style={{ color: "var(--bad)" }}>{p.failureMessage}</div> : null}
                          </td>
                          <td>
                            <Chip tone={PAY_TONE[p.status] ?? "v"}>{titleCase(p.status)}</Chip>
                          </td>
                          <td className="num-cell">{money(p.amountCents, { exact: true })}</td>
                          <td className="num-cell">{p.amountRefundedCents ? money(p.amountRefundedCents, { exact: true }) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={payPage} limit={20} total={payments.meta.total ?? 0} onPage={setPayPage} />
              </>
            ) : (
              <Empty icon="card" title="No payments yet" />
            )}
          </div>

          {canManage ? (
            <>
              <div className="section-h">
                <h2>Account</h2>
              </div>
              <div className="panel glass cr-acct">
                <div>
                  <b>Close account</b>
                  <p className="muted">Stops sending, switches auto-reload off and removes your card. No support ticket needed.</p>
                </div>
                <Button size="sm" onClick={() => setClosing(true)}>
                  Close account
                </Button>
              </div>
              {closing ? <CloseAccount onClose={() => setClosing(false)} /> : null}
            </>
          ) : null}
        </>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SkeletonRows rows={3} h={80} />}>
      <CreditsPage />
    </Suspense>
  );
}
