import { redirect } from "next/navigation";

/** Billing is the credits panel now: there are no plans or subscriptions. */
export default function Page() {
  redirect("/app/billing/credits");
}
