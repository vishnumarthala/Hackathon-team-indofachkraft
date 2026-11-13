import { redirect } from "next/navigation";
import { getUserRole, requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// FR-7 `/notifications`: each role reads its list inside its own shell.
export default async function NotificationsPage() {
  const user = await requirePageUser();
  const role = await getUserRole(user.id);
  redirect(role === "guardian" ? "/family/notifications" : "/dashboard/notifications");
}
