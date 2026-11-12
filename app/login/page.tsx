import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import "@/components/landing/landing.css";
import { LoginForm } from "@/components/auth/LoginForm";
import { fontVars } from "@/components/landing/fonts";
import { Logo } from "@/components/landing/ui";
import { getAuthenticatedUser } from "@/lib/auth";
import blocksImage from "@/public/landing/blocks.jpg";

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
  return (
    <div className={`lp-root ${fontVars} grid min-h-screen lg:grid-cols-[1fr_0.95fr]`}>
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:px-20">
        <Link href="/" aria-label="DoctorNearMe home" className="w-fit rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30">
          <Logo />
        </Link>

        <div className="lp-fade-up mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-16">
          <LoginForm nextPath={safeNextPath(next)} />
          <p className="mt-8 text-center text-sm text-slate-600">
            New to DoctorNearMe?{" "}
            <Link href="/book-demo" className="font-semibold text-teal-800 underline-offset-4 hover:underline">
              Book a demo
            </Link>
          </p>
        </div>

        <p className="text-xs text-slate-500">DoctorNearMe supports clinicians. It is not a diagnosis.</p>
      </div>

      <div className="relative hidden overflow-hidden bg-[#0b1f1d] lg:block">
        <Image src={blocksImage} alt="" fill priority sizes="50vw" className="lp-ken object-cover" placeholder="blur" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b1f1d]/85 via-[#0b1f1d]/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-14 text-white">
          <p className="lp-display max-w-md text-5xl leading-[1.05]">
            AI documents, <em className="text-teal-200">the clinician decides.</em>
          </p>
          <p className="mt-4 max-w-sm text-white/70">Your cases, briefs and ISAA reviews are waiting in your workspace.</p>
        </div>
      </div>
    </div>
  );
}
