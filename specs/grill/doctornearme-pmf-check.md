# DoctorNearMe: Product–market fit check (Hyderabad pilot)

**Date:** 2026-11-13 · **Inputs:** [decision record](doctornearme-mvp.md), the built product on `main`,
the [Figma journeys](https://www.figma.com/board/RfeKYhTAT8MDj5kMbG7hfy), and desk research (sources at the end).
**Status:** analysis, not yet confirmed by the product owner. Nothing here has been tested with real
customers. Every "fit" judgement below is a hypothesis to check in interviews and the pilot.

## 1. Verdict in one paragraph

The **problem is real and large**, but the **product is too broad for one pilot**, and three of its
core assumptions don't match the Hyderabad customer:

- **Language.** The new voice agents speak English only. Hyderabad's parents mostly speak Telugu,
  and Urdu is the second language, not Hindi.
- **Assessment tool.** The product is built around ISAA, which is a disability-certification tool that
  works poorly under age 5. Early intervention is exactly the under-5 group.
- **Visits.** Booking covers one visit, but early intervention is 2–4 sessions a week for months, which
  centres sell as monthly packages.

The strongest wedge is **B2B**: give independent centres "chain-grade" tools (AI notes, parent intake,
home program, parent app) so they can compete with Pinnacle Blooms. The weakest bet is the public
directory as the acquisition channel.

**Fit by part of the product:**
- **Strong:** the problem (late help, too few specialists), AI documentation, the home program, and the
  family portal for families a centre invites.
- **Needs change:** the parent check-in (language, tool, and voice only), booking (one visit only), the
  landing page (aimed at therapists, with US and German statistics), and how the product makes money
  (not defined).
- **Weak for now:** the cold "near me" directory as the main acquisition channel, prescriptions as a
  headline feature, and Google Meet with a mandatory Google account.

## 2. Who the ideal customers are

| | Who | Pays? | What they want |
|---|---|---|---|
| **Buyer** | Owner of an independent child-development centre in Hyderabad (3–15 staff: speech, OT, special educator, sometimes a visiting psychologist), or a solo therapist | Yes, monthly SaaS | Full schedule, fewer dropouts, less paperwork, parents who practise at home, proof of progress for parents, more referrals, look as professional as the chains |
| **User (family)** | Mother of a child aged 1.5–8 with speech or social concerns. Uses an Android phone and WhatsApp, speaks Telugu (some Urdu or Hindi, English for some), and is often sent by a paediatrician | No (pays the centre ₹500–2,500 per session, 2–4 times a week) | "Will my child talk?", a trusted and affordable place near home, what to do at home, no stigma, the disability certificate (UDID) later |
| **Gatekeeper** | Paediatrician or GP (74% of families go to them first in one study) | No | A place to send worried parents, and getting feedback on the child |

The product has no journey for the gatekeeper today.

## 3. Journey check from the customer's seat

### 3a. Parent arriving cold (current FigJam "Family journey")

| Step | Parent's thought | Fit | Why |
|---|---|---|---|
| Lands on `/` | "This is for therapists, not me." | ✗ | The hero says "For early intervention therapists" and quotes US and German statistics. Parents only find `/find` and `/screen` in the nav and one lower button. |
| Voice check-in `/screen` | "I don't want to talk about my child out loud in English; my mother-in-law is in the room." | ✗ | The agent is English only. (A tap-through version already exists, so parents can answer silently.) The questions are based on ISAA, which is poor under age 5. Pinnacle Blooms already offers a free online "AbilityScore". |
| Red flag → 108/112 | "Good, it's safe." | ✓ | Keep. |
| Result → `/find` | "Do I need a speech therapist, an OT or a doctor?" | ~ | The result should recommend the kind of professional, not just send the parent to a list. |
| Directory | "Who are these people? Are they real?" | ~ | Parents mostly come through referrals and word of mouth. A thin directory with "Demo profile" badges lowers trust. Supply density decides whether this step works. |
| Book, sign in, pay | "OK for the first assessment." | ✓ | It's fine for the first visit. In-clinic visits are paid at the clinic. |
| Permissions, then AI intake call | "Lots of questions before I've even met anyone." | ~ | It's valuable, but the parent has to say yes to several separate permissions before the call. The new agents speak English only; the Child Development agent supports en/hi/te. |
| Visit | | ✓ / ✗ | Clinic visits fit. Video visits require a Google account, which is fine for a minority. |
| Ongoing care in the portal | "Where are my next ten sessions?" | ✗ | Only the first visit is booked in the app. Later sessions happen outside it, so the "Visits" tab stays empty and families stop opening the portal. |

**Verdict:** the cold path has too many steps before any value and three blockers: language, landing
page and trust in the directory. Keep it, but it isn't the pilot's main path.

### 3b. Parent invited by their centre (exists in code, missing from the journey map)

The centre creates the child, sends a **clinic code over WhatsApp**
(`components/consent/ClaimCodeButton.tsx`), and the parent signs in, enters the code, gives
permissions, then gets the intake call, home program, plan, notes and messages.

| Step | Fit | Note |
|---|---|---|
| WhatsApp message from *their* centre | ✓✓ | Trust is already there, and it arrives on WhatsApp. |
| Sign in + code | ~ | Phone OTP needs DLT registration first. Until then it's Google only, which adds friction. |
| Permissions | ✓ | Paper consent covers parents without a smartphone. |
| Home program + practice logs | ✓✓ | Parent-led practice is where the parent gets the most value, and it gives the parent a reason to come back each week. |
| "Ask about my child" | ~ | Useful only once the therapist has published something. The agent speaks English only. |

**Verdict:** this is the journey with fit, so make it **journey #1** in the pilot, the FigJam board and
the landing page.

### 3c. Centre owner / therapist

| Step | Owner's thought | Fit | Why |
|---|---|---|---|
| Landing, then book a demo | "Less paperwork, I like it." | ✓ | The message works. Swap in Indian statistics. |
| Join, verification, profile | | ✓ | Admin judgement for OT, speech and ABA is fine for the pilot. Store RCI registration numbers for speech therapists and psychologists, because the law ties those titles to the RCI register. |
| Day 1: "Where do my 80 current children go?" | ✗ | | There's no bulk import, so each child is added by hand. |
| Day 2: weekly timetable | ✗ | | There are no recurring sessions, attendance, monthly packages or receipts. These are the daily jobs, so the owner still keeps Excel or another tool. |
| AI scribe, then ISAA review | ~ | | ISAA is used once per child, mostly by psychologists, mainly for certification after age 6. The weekly value is the **session note + goal progress**, so lead with that. |
| Report and referral to a specialist | ✓ | | Matches the real flow from therapist to developmental paediatrician for diagnosis. |
| Goals and home program | ✓✓ | | Shows progress to parents, which helps keep families in therapy. |
| Prescriptions | – | | Most early intervention centres have no doctor who can prescribe. Keep it, but don't lead with it. |
| Price | ✗ | | No price, plan or billing exists, so the pilot can't test willingness to pay. The anchor is Practo Ray at about ₹999–1,999 a month per clinic. |

**Verdict:** the AI value is real, but the **daily operating jobs are missing**. Without them the
product is an add-on, not the centre's system, and add-ons are easy to drop.

### 3d. Paediatrician (missing)

There's no journey for them. A low-cost version: a printable Telugu/Hindi/English QR poster for the
waiting room that links to the check-in with "referred by Dr X". Later, a feedback note back to the
paediatrician.

## 4. Competitive position (Hyderabad)

- **Pinnacle Blooms** (100+ centres, a free online AbilityScore, 7.9 lakh children claimed). It competes
  for parents and won't buy our SaaS. Positioning: **"the tools of a chain, for the independent centre
  your family already trusts."**
- **CogniAble and Butterfly Learnings** are ABA/therapy chains, not software vendors.
- **Practo Ray** is generic clinic software (about ₹1–2k a month), not built for therapists: no goals,
  home program or AI notes.
- **Government DEICs** (0–6 years, free) and **NIEPID Secunderabad** serve low-income families. List them
  in results as free options; it builds trust.
- **No Indian AI scribe for therapists found** (not proof there's none). This is the open space.

## 5. Recommendations (ranked)

**Before the real pilot**
1. **Pick one buyer and one journey.** Centres are the paying customer, and the centre-invited parent
   journey is the main one. Redraw the FigJam board with that journey first.
2. **Split the landing page.** A "For centres" page (as now, with Indian statistics: INCLEN 1 in 100
   under 10, diagnosis at about 4.6 years in India) and a "For parents" page in Telugu, Hindi and English.
3. **Give the voice agents Telugu (and Hindi).** *Decided 2026-11-13: no Urdu; languages stay en / hi / te.*
   Turn on Telugu and Hindi for the parent check-in, booking, intake and follow-up agents. That's mostly ElevenLabs configuration,
   not code.
4. **Fix the check-in tool.** Base the parent check-in for ages 16–30 months on M-CHAT-R/F (check the
   licence for commercial digital use first). Keep the existing tap-through choice. Keep ISAA for
   clinicians (age 3+, certification support), and add INDT-ASD as the diagnosis tool in the instrument
   list.
5. **Add the minimum "centre's daily system":** recurring weekly sessions per child, attendance,
   monthly packages with a receipt (pay at the clinic or with a Razorpay link), and a CSV import of
   existing children.
6. **Set a price and ask for money in the pilot.** For example, ₹1,500 per therapist per month, or
   ₹4,999 per centre, with a free first month. A signed letter of intent counts as a result.

**Next**
7. A paediatrician QR referral kit.
8. Recommend the kind of professional on the result screen, and show DEIC/NIEPID as free options.
9. Locality pages for search ("speech therapy in Kukatpally"). This is where cold demand comes from,
   rather than a generic `/find`.
10. Store and show RCI numbers on profiles. Show "Demo profile" only outside the pilot area.

**Defer:** video visits and Meet, ratings, prescriptions as a selling point, more general specialties
from the original telemedicine plan.

## 6. How to measure fit in the pilot (5–8 centres, 8–12 weeks)

| Signal | Target that says "fit" |
|---|---|
| Centres that pay (or sign a letter of intent) after the free month | ≥ 3 of 5 |
| Weekly active therapists ÷ invited therapists | ≥ 70% |
| Sessions with an AI note that the therapist accepts | ≥ 60% of sessions |
| Documentation time saved, as reported by therapists | ≥ 30 minutes a day |
| Invited parents who claim the child and give consent | ≥ 60% |
| Parents logging home practice at least weekly | ≥ 40% at week 6 |
| Sean Ellis test ("very disappointed if it went away"), centre owners | ≥ 40% |

**Questions for the first 10 centre interviews:**
- How do new families find you today?
- What do you use for the timetable, attendance and fees?
- How long do notes and reports take each day?
- Why do families stop coming?
- What do you send parents between sessions?
- Would you pay ₹X a month, and who decides?

## 7. Product owner answers (2026-11-13)
1. **Who pays: both** (corrected later the same day). The family pays **on DoctorNearMe**, and DoctorNearMe
   pays the centre or therapist after each consultation, keeping a platform fee (Razorpay Route). → 045, 046.
2. **No Urdu.** Languages stay en / hi / te. → 049 adds hi and te to the new voice agents.
3. **Yes** to recurring sessions, packages and attendance before the pilot. → 043, 044, 045, plus 047 (import).
4. **Up to 8 years.** → 048: age-aware check-in (M-CHAT-R/F for toddlers once licensed, ISAA-derived for
   2½–8), concern-based advice, free options.

5. **Voice credits.** Anonymous visitors must not be able to burn voice minutes. → 051: voice needs sign-in,
   per-user quotas, a platform budget, and tapping as the free default.
6. **Target: a journey score of at least 9/10.** → 048-050 approved; 052 (next steps everywhere) and 053
   (design alignment) added.

Recorded in the [decision record](doctornearme-mvp.md) (decisions 8–13) and on the
[board](../tickets/BOARD.md) (M4). Still open: the platform fee rate and the tax treatment, which needs a CA
(see 046).

## Sources
- INCLEN neurodevelopmental prevalence (includes a Hyderabad site): https://pmc.ncbi.nlm.nih.gov/articles/PMC6057634/
- ISAA's role (certification, RPwD), weak under 5: https://pmc.ncbi.nlm.nih.gov/articles/PMC11572347/
- Age at diagnosis 4.6 years (Chandigarh, n=1,321): https://www.ovid.com/jnls/ijph/fulltext/10.4103/ijph.ijph_1801_21~age-at-diagnosis-for-autism-spectrum-disorders-does-it
- Care pathway, 74% go to a GP first (Odisha, n=38): https://pmc.ncbi.nlm.nih.gov/articles/PMC7055625
- RCI register counts, 2023-24: https://cdnbbsr.s3waas.gov.in/s34f4eeef3a8c90dfceaddd5c6d64e4ebb/uploads/2025/07/202507141090347321.pdf
- RCI Act s.13: https://cdnbbsr.s3waas.gov.in/s34f4eeef3a8c90dfceaddd5c6d64e4ebb/uploads/2025/07/202507071149264140.pdf
- Telangana languages (Census 2011): https://en.wikipedia.org/wiki/Demographics_of_Telangana (secondary)
- Therapy prices (vendor-sourced): https://pinnacleblooms.org/ask/how-much-does-autism-or-speech-therapy-cost-in-india
- Practo Ray plans: https://www.practo.com/providers/clinics/ray/plans
- DEIC/RBSK guidelines: https://nhm.gov.in/images/pdf/programmes/RBSK/Operational_Guidelines/Operational%20Guidelines_RBSK.pdf
- DPDP Act: https://egazette.gov.in/WriteReadData/2023/248045.pdf · DPDP Rules 2025: https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf
- Telemedicine Practice Guidelines (secondary): https://pmc.ncbi.nlm.nih.gov/articles/PMC10448835/
- Competitors: https://www.pinnacleblooms.org/ · https://cogniable.tech/ · https://www.butterflylearnings.com/

**Unverified:** Hyderabad waiting times, how parents find therapists (shares by channel), who may sign
UDID autism certificates, OT headcount, the licence terms for M-CHAT-R/F in commercial software, and
NMC rules on doctor directories. Check these before relying on them.
