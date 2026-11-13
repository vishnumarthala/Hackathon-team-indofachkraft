// Runs once when a Next.js server instance starts (before it serves requests).
// 031 D-1: Razorpay is test mode only. A non-test key id (e.g. `rzp_live_...`) stops the server from starting.
export function register() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (keyId && !keyId.startsWith("rzp_test_")) {
    throw new Error("Razorpay live keys are not allowed: RAZORPAY_KEY_ID must start with rzp_test_ (test mode only).");
  }
}
