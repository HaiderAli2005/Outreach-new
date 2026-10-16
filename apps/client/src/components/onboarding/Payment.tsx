"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Icon } from "@/components/ui/Icon";
import { usd } from "./sizing";
import { Button, Notice, Skeleton } from "@/components/ui/primitives";
import { errorMessage, useBillingConfigQuery, usePaymentToConfirmQuery, useStartSetupMutation, useTopupMutation } from "@/store/api";

const stripeCache = new Map<string, Promise<Stripe | null>>();
export function stripeFor(key: string) {
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return stripeCache.get(key)!;
}

/** One key per workspace and amount, so a reload reuses the same payment instead of starting a second one. */
function idempotencyKey(orgId: string, signature: string): string {
  const k = `ap_top_${orgId}_${signature}`;
  try {
    const found = sessionStorage.getItem(k);
    if (found) return found;
    const v = `${orgId}-${crypto.randomUUID()}`;
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return `${orgId}-${crypto.randomUUID()}`;
  }
}

export type PayHandle = () => Promise<void>;

function CardForm({ register, onPaid, onBusy, onError, returnUrl }: { register: (h: PayHandle | null) => void; onPaid: () => void; onBusy: (b: boolean) => void; onError: (m: string) => void; returnUrl: string }) {
  const stripe = useStripe();
  const elements = useElements();
  useEffect(() => {
    if (!stripe || !elements) return register(null);
    register(async () => {
      onBusy(true);
      onError("");
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      onBusy(false);
      if (error) onError(error.message ?? "The payment didn't go through. Try another card.");
      else onPaid();
    });
    return () => register(null);
  }, [stripe, elements, register, onPaid, onBusy, onError, returnUrl]);
  return <PaymentElement options={{ layout: "tabs" }} />;
}

/**
 * The card form for one prepaid top-up. The card is charged now, while the customer is here; nothing is ever charged
 * later without them. The balance moves when Stripe confirms the payment to the server.
 */
export function TopupForm({
  orgId,
  amount,
  register,
  onPaid,
  onBusy,
  returnPath = "/onboarding?paid=1",
}: {
  orgId: string;
  /** Exact deci-cents, as a string from the server's top-up options. */
  amount: string;
  register: (h: PayHandle | null) => void;
  onPaid: () => void;
  onBusy: (b: boolean) => void;
  returnPath?: string;
}) {
  const { data: cfg, isLoading: cfgLoading } = useBillingConfigQuery();
  const [topup, { isLoading }] = useTopupMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [payErr, setPayErr] = useState("");
  const started = useRef("");

  useEffect(() => {
    if (!cfg?.enabled || !amount || started.current === amount) return;
    started.current = amount;
    setSecret(null);
    setErr("");
    topup({ amount, idempotencyKey: idempotencyKey(orgId, amount) })
      .unwrap()
      .then((r) => setSecret(r.clientSecret))
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg?.enabled, topup, orgId, amount]);

  const stripePromise = useMemo(() => (cfg?.publishableKey ? stripeFor(cfg.publishableKey) : null), [cfg?.publishableKey]);
  const returnUrl = typeof window === "undefined" ? returnPath : `${window.location.origin}${returnPath}`;

  if (cfgLoading) return <Skeleton h={220} r={24} />;
  if (!cfg?.enabled)
    return (
      <Notice tone="bad" title="Payments are not set up on this server">
        Stripe keys are missing, so a top-up can&apos;t start. An administrator needs to add them first.
      </Notice>
    );

  return (
    <div className="cardform glass">
      <div className="top">
        <b>Card details</b>
        {cfg.publishableKey?.startsWith("pk_test") ? <span className="test">Test mode</span> : null}
      </div>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : !secret || !stripePromise || isLoading ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Skeleton h={48} />
          <Skeleton h={48} />
          <Skeleton h={48} />
        </div>
      ) : (
        <Elements
          key={secret}
          stripe={stripePromise}
          options={{
            clientSecret: secret,
            appearance: {
              theme: "night",
              variables: { colorPrimary: "#D4AE72", colorBackground: "#1c1c1b", colorText: "#F2EEE7", colorDanger: "#E5836F", borderRadius: "12px", fontFamily: "system-ui, sans-serif" },
            },
          }}
        >
          <CardForm register={register} onPaid={onPaid} onBusy={onBusy} onError={setPayErr} returnUrl={returnUrl} />
        </Elements>
      )}
      {payErr ? (
        <div className="banner bad" role="alert">
          {payErr}
        </div>
      ) : null}
      <div className="secure">
        <Icon id="lock" />
        Charged once, now. Never charged again unless you switch on auto-reload. Card details never touch our servers.
      </div>
    </div>
  );
}

/**
 * An auto-reload the customer's bank asked them to approve (3-D Secure). Opened from the link in our email; the
 * customer approves it here, in the page, and the balance moves when Stripe confirms it.
 */
export function ConfirmAutoReload({ paymentIntentId, onDone, onClose }: { paymentIntentId: string; onDone: () => void; onClose: () => void }) {
  const { data: cfg } = useBillingConfigQuery();
  const { data, isLoading, error } = usePaymentToConfirmQuery(paymentIntentId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (isLoading) return <Skeleton h={96} r={16} />;
  if (error || !data) return <Notice tone="bad" title="This payment can't be approved">{error ? errorMessage(error) : "It may already be finished or cancelled."}</Notice>;
  if (data.status === "succeeded")
    return (
      <Notice tone="good" icon="check" title="Already approved">
        {data.amount} is in your balance.
      </Notice>
    );
  const approve = async () => {
    if (!cfg?.publishableKey) return setErr("Payments are not set up on this server.");
    setBusy(true);
    setErr("");
    const stripe = await stripeFor(cfg.publishableKey);
    const r = await stripe?.confirmCardPayment(data.clientSecret, data.paymentMethodId ? { payment_method: data.paymentMethodId } : undefined);
    setBusy(false);
    if (!stripe) setErr("Stripe didn't load. Try again.");
    else if (r?.error) setErr(r.error.message ?? "Your bank didn't approve it. Try again or top up with another card.");
    else onDone();
  };
  return (
    <div className="panel glass ar-confirm">
      <b>Approve your {data.amount} auto-reload</b>
      <p className="muted">Your bank asked you to approve this payment before it goes through. Nothing has been charged yet. Auto-reload stays off until you switch it back on.</p>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : null}
      <div className="bc-nudge-a">
        <button type="button" className="btn btn-text btn-sm" onClick={onClose}>
          Not now
        </button>
        <Button size="sm" variant="primary" loading={busy} onClick={approve}>
          Approve {data.amount}
        </Button>
      </div>
    </div>
  );
}

const APPEARANCE = {
  theme: "night" as const,
  variables: { colorPrimary: "#D4AE72", colorBackground: "#1c1c1b", colorText: "#F2EEE7", colorDanger: "#E5836F", borderRadius: "12px", fontFamily: "system-ui, sans-serif" },
};

function SetupFields({ register, onSaved, onBusy, onError, returnUrl }: { register: (h: PayHandle | null) => void; onSaved: () => void; onBusy: (b: boolean) => void; onError: (m: string) => void; returnUrl: string }) {
  const stripe = useStripe();
  const elements = useElements();
  useEffect(() => {
    if (!stripe || !elements) return register(null);
    register(async () => {
      onBusy(true);
      onError("");
      const { error } = await stripe.confirmSetup({ elements, confirmParams: { return_url: returnUrl }, redirect: "if_required" });
      onBusy(false);
      if (error) onError(error.type === "card_error" ? "That card was declined. Try another card." : (error.message ?? "The card couldn't be saved. Try another card."));
      else onSaved();
    });
    return () => register(null);
  }, [stripe, elements, register, onSaved, onBusy, onError, returnUrl]);
  return <PaymentElement options={{ layout: "tabs" }} />;
}

/**
 * Saves a card without charging it (a SetupIntent, on-session only). Adding it unlocks the free credit. The card can
 * be removed any time from Credits.
 */
export function CardSetupForm({ orgId, register, onSaved, onBusy, returnPath = "/onboarding?card=1" }: { orgId: string; register: (h: PayHandle | null) => void; onSaved: () => void; onBusy: (b: boolean) => void; returnPath?: string }) {
  const { data: cfg, isLoading: cfgLoading } = useBillingConfigQuery();
  const [start] = useStartSetupMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [cardErr, setCardErr] = useState("");
  const started = useRef(false);
  useEffect(() => {
    if (!cfg?.enabled || started.current) return;
    started.current = true;
    start({ purpose: "card", idempotencyKey: idempotencyKey(orgId, "card") })
      .unwrap()
      .then((r) => setSecret(r.clientSecret))
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg?.enabled, start, orgId]);
  const stripePromise = useMemo(() => (cfg?.publishableKey ? stripeFor(cfg.publishableKey) : null), [cfg?.publishableKey]);
  const returnUrl = typeof window === "undefined" ? returnPath : `${window.location.origin}${returnPath}`;

  if (cfgLoading) return <Skeleton h={220} r={24} />;
  if (!cfg?.enabled)
    return (
      <Notice tone="bad" title="Payments are not set up on this server">
        Stripe keys are missing, so a card can&apos;t be added. An administrator needs to add them first.
      </Notice>
    );
  return (
    <div className="cardform glass">
      <div className="top">
        <b>Card details</b>
        {cfg.publishableKey?.startsWith("pk_test") ? <span className="test">Test mode</span> : null}
      </div>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : !secret || !stripePromise ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Skeleton h={48} />
          <Skeleton h={48} />
        </div>
      ) : (
        <Elements key={secret} stripe={stripePromise} options={{ clientSecret: secret, appearance: APPEARANCE }}>
          <SetupFields register={register} onSaved={onSaved} onBusy={onBusy} onError={setCardErr} returnUrl={returnUrl} />
        </Elements>
      )}
      {cardErr ? (
        <div className="banner bad" role="alert">
          {cardErr}
        </div>
      ) : null}
      <div className="secure">
        <Icon id="lock" />
        We won&apos;t charge this card. Your bank may show a temporary $0.00 check, which disappears on its own. You can remove the card any time from Credits.
      </div>
    </div>
  );
}

/**
 * The separate consent auto-reload needs: an off-session SetupIntent on the saved card, approved in the page (the
 * bank may ask for 3-D Secure). Returns the SetupIntent id the settings change sends to the server to check.
 */
export async function confirmOffSessionConsent(publishableKey: string, clientSecret: string, paymentMethodId: string | null): Promise<string> {
  const stripe = await stripeFor(publishableKey);
  if (!stripe) throw new Error("Stripe didn't load. Try again.");
  const r = await stripe.confirmCardSetup(clientSecret, paymentMethodId ? { payment_method: paymentMethodId } : undefined);
  if (r.error) throw new Error(r.error.message ?? "Your bank didn't approve it.");
  if (!r.setupIntent?.id) throw new Error("Stripe didn't confirm it. Try again.");
  return r.setupIntent.id;
}

/**
 * Paying for credit once a card is saved: one button, on that card. No card form unless the customer asks to use a
 * different card. A bank check (3-D Secure) opens in Stripe's own window; a decline is said in plain words.
 */
export function TopupPay({
  orgId,
  amount,
  card,
  onPaid,
  returnPath,
}: {
  orgId: string;
  amount: string;
  card: { brand: string; last4: string } | null;
  onPaid: () => void;
  returnPath: string;
}) {
  const { data: cfg } = useBillingConfigQuery();
  const [topup] = useTopupMutation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [other, setOther] = useState(!card);
  const pay = useRef<PayHandle | null>(null);
  const [ready, setReady] = useState(false);
  const register = useCallback((h: PayHandle | null) => {
    pay.current = h;
    setReady(!!h);
  }, []);
  useEffect(() => setErr(""), [amount]);
  const dollars = usd(amount);

  async function paySaved() {
    setBusy(true);
    setErr("");
    try {
      // A fresh key per press: a second top-up of the same amount is a new payment, never the old one again.
      const r = await topup({ amount, idempotencyKey: `${orgId}-${crypto.randomUUID()}`, savedCard: true }).unwrap();
      if (r.status === "requires_action" && cfg?.publishableKey) {
        const stripe = await stripeFor(cfg.publishableKey);
        const res = await stripe?.handleNextAction({ clientSecret: r.clientSecret });
        if (res?.error) throw new Error(res.error.message ?? "Your bank didn't approve the payment.");
      } else if (r.status && !["succeeded", "processing"].includes(r.status)) {
        throw new Error("The payment didn't go through. Try again, or use a different card.");
      }
      onPaid();
    } catch (e) {
      setErr(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (other)
    return (
      <div className="pay">
        <TopupForm orgId={orgId} amount={amount} register={register} onPaid={onPaid} onBusy={setBusy} returnPath={returnPath} />
        <div className="panel glass">
          <h3>{dollars} of credit</h3>
          <p style={{ marginTop: 6 }}>Charged once, now. Unused credit stays in your balance.</p>
          <Button variant="primary" style={{ marginTop: 14 }} loading={busy} disabled={!ready} onClick={() => pay.current?.()}>
            Pay {dollars}
          </Button>
          {card ? (
            <button type="button" className="linkish" style={{ marginTop: 12 }} onClick={() => setOther(false)}>
              Pay with {card.brand} ending {card.last4} instead
            </button>
          ) : null}
        </div>
      </div>
    );
  return (
    <div className="panel glass paysaved">
      <div>
        <h3>{dollars} of credit</h3>
        <p className="muted" style={{ marginTop: 4 }}>
          Charged once, now, to your {card!.brand} ending {card!.last4}. Unused credit stays in your balance.
        </p>
        {err ? (
          <p className="au-err" role="alert" style={{ marginTop: 8 }}>
            {err}
          </p>
        ) : null}
      </div>
      <div className="paysaved-a">
        <Button variant="primary" loading={busy} onClick={() => void paySaved()}>
          Pay {dollars}
        </Button>
        <button type="button" className="linkish" onClick={() => setOther(true)} disabled={busy}>
          Use a different card
        </button>
      </div>
    </div>
  );
}
