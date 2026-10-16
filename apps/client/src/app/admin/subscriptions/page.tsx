import { redirect } from "next/navigation";

/** Plans and subscriptions are gone: customers prepay credits. The pool console replaces this page. */
export default function Page() {
  redirect("/admin/pool");
}
