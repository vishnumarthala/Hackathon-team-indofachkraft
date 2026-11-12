import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInvitation } from "@/components/team/TeamForms";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Invitation - DoctorNearMe" };

// Public page: the token is only checked when the signed-in user accepts, so nothing about the
// organisation is revealed to someone holding the link without the invited account.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getAuthenticatedUser();

  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">Join your team on DoctorNearMe</h1>
      {user ? (
        <>
          <p className="text-slate-700">
            Signed in as <span className="font-medium">{user.email}</span>. The invitation must have been sent to this email.
          </p>
          <AcceptInvitation token={token} />
        </>
      ) : (
        <p className="text-slate-700">
          <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="font-medium underline">
            Sign in
          </Link>{" "}
          with the email address the invitation was sent to, then accept it here.
        </p>
      )}
    </div>
  );
}
