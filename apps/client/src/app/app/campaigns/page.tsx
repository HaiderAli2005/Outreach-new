import { redirect } from "next/navigation";

/** Campaigns are no longer a list of their own: the active campaign is edited under Setup. */
export default function Page() {
  redirect("/app/setup/targeting");
}
