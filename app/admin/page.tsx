import { notFound, redirect } from "next/navigation";
import { getUserRole, requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 019 FR-3: `/admin` is the platform admin's home; the account directory is its only page so far.
export default async function AdminHomePage() {
  const user = await requirePageUser();
  if ((await getUserRole(user.id)) !== "platform_admin") notFound();
  redirect("/admin/users");
}
