// Guardian sign-in methods (ticket 019, FR-8/FR-9). Derived from the Supabase user; never from client input.
import type { User, UserIdentity } from "@supabase/supabase-js";

export type SignInProvider = "google" | "phone";

export type SignInMethods = {
  /** Linked Google identity (email shown as "Connected as ..."), or null. */
  google: { email: string | null } | null;
  /** Confirmed phone in E.164 digits, or null. */
  phone: string | null;
};

export const UNLINK_LAST_METHOD_ERROR = "Add another sign-in method first";

function googleIdentity(identities: UserIdentity[] | undefined): UserIdentity | undefined {
  return identities?.find((identity) => identity.provider === "google");
}

export function signInMethods(user: Pick<User, "identities" | "phone" | "phone_confirmed_at">): SignInMethods {
  const google = googleIdentity(user.identities);
  const email = google?.identity_data?.email;
  return {
    google: google ? { email: typeof email === "string" ? email : null } : null,
    phone: user.phone && user.phone_confirmed_at ? user.phone.replace(/^\+/, "") : null,
  };
}

/** FR-9: a method may be removed only while at least one other method remains. */
export function canUnlink(methods: SignInMethods, provider: SignInProvider): boolean {
  const count = (methods.google ? 1 : 0) + (methods.phone ? 1 : 0);
  const has = provider === "google" ? methods.google !== null : methods.phone !== null;
  return has && count >= 2;
}
