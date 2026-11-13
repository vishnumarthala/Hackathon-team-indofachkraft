import { voiceSignInHref } from "@/lib/voice/constants";

// 050: `/` is for parents (D-1). The therapist / centre landing lives at `/for-centres`.
export const PARENT_LINKS = {
  checkIn: "/screen",
  find: "/find",
  claim: "/family/children/claim",
  forCentres: "/for-centres",
  // 051: anonymous visitors never start voice; they sign in first and come back to the check-in in voice mode.
  voice: voiceSignInHref("/screen?voice=1"),
} as const;
