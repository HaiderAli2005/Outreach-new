"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Chip, TextField, ViewHead } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { AdminTable } from "@/components/app/AdminTable";
import { useToast } from "@/store";
import { errorMessage, useAdminRefundMutation } from "@/store/api";
import { dateLong, money, titleCase } from "@/lib/format";
import type { Payment } from "@/lib/types";

const STATUSES = ["REQUIRES_PAYMENT", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];

function RefundModal({ p, onClose }: { p: Payment; onClose: () => void }) {
  const refundable = p.amountCents - p.amountRefundedCents;
  const [amount, setAmount] = useState((refundable / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [refund, { isLoading }] = useAdminRefundMutation();
  const toast = useToast();
  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && cents <= refundable;
  return (
    <Modal
      title="Refund payment"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={isLoading}
            disabled={!valid}
            onClick={() =>
              refund({ id: p.id, amountCents: cents === refundable ? undefined : cents, reason: reason.trim() || undefined })
                .unwrap()
                .then(() => {
                  toast(`Refund of ${money(cents, { exact: true })} sent to Stripe`, "good");
                  onClose();
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Refund {valid ? money(cents, { exact: true }) : ""}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {p.organization?.name} paid {money(p.amountCents, { exact: true })} on {dateLong(p.createdAt)}. Up to {money(refundable, { exact: true })} can be refunded.
        </p>
        <TextField label="Amount (USD)" type="number" step="0.01" min="0.01" max={(refundable / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} error={valid ? null : "Enter an amount up to the refundable balance"} />
        <TextField label="Reason" hint="Kept with the refund record" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        {err ? (
          <div className="banner bad" role="alert">
            {err}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default function AdminPayments() {
  const [refunding, setRefunding] = useState<Payment | null>(null);
  return (
    <>
      <ViewHead kicker="Admin" title="Payments." sub="Refunds go through Stripe with an idempotency key and are confirmed by webhook." />
      <AdminTable
        resource="payments"
        filters={[{ key: "status", label: "Any status", options: STATUSES.map((s) => [s, titleCase(s)] as [string, string]) }]}
        columns={[
          { label: "Date", render: (r) => <span className="m">{dateLong(String(r.createdAt))}</span> },
          { label: "Organization", render: (r) => { const p = r as unknown as Payment; return p.organization ? <Link href={`/admin/organizations/${p.organization.id}`}><b>{p.organization.name}</b></Link> : null; } },
          { label: "Status", render: (r) => <Chip tone={r.status === "SUCCEEDED" ? "g" : r.status === "FAILED" ? "r" : "v"}>{titleCase(String(r.status))}</Chip> },
          { label: "Amount", right: true, render: (r) => money(Number(r.amountCents), { exact: true }) },
          { label: "Refunded", right: true, render: (r) => (Number(r.amountRefundedCents) ? money(Number(r.amountRefundedCents), { exact: true }) : "") },
          {
            label: "Actions",
            render: (r) => {
              const p = r as unknown as Payment;
              return ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status) && p.amountCents > p.amountRefundedCents ? (
                <Button size="xs" variant="text" onClick={() => setRefunding(p)}>
                  Refund
                </Button>
              ) : null;
            },
          },
        ]}
      />
      {refunding ? <RefundModal p={refunding} onClose={() => setRefunding(null)} /> : null}
    </>
  );
}
