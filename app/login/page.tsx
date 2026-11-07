import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

function safeNextPath(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/dashboard";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (user) redirect("/dashboard");

  const { next } = await searchParams;
  return <LoginForm nextPath={safeNextPath(next)} />;
}
