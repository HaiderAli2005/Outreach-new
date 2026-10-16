import { redirect } from "next/navigation";

/** Short link to the credits panel inside the app. */
export default function Page() {
  redirect("/app/billing/credits");
}
