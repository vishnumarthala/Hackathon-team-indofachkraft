# DoctorNearMe: Design System & UI

The Figma file is the visual source of truth for DoctorNearMe screens. The code (Tailwind classes, plus
fonts in `app/globals.css`, and components in `components/`) is the behavioural source of truth. If they
disagree, follow the decision record ([doctornearme-mvp.md](../specs/grill/doctornearme-mvp.md)) and fix
the other side.

Related: [system design](system-design.md) · [team workflow](team-workflow.md) ·
[ticket board](../specs/tickets/BOARD.md)

## 1. Where things live

| What | Link |
|---|---|
| Design system + all screens | [DoctorNearMe — Care Design System & App UI](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo) |
| User journeys (FigJam) | [DoctorNearMe — Family journey & Clinician workflow](https://www.figma.com/board/RfeKYhTAT8MDj5kMbG7hfy) |

Figma pages: **Cover** · **Foundations** (swatches, type ramp, spacing, elevation, principles) ·
**Components** · **Screens · Public & parents** · **Screens · Family portal** ·
**Screens · Provider workspace** · **Screens · Admin**. Frames are named `route — title`, so you can
find a route by searching the layers panel.

## 2. Design direction: "Care DS"

DoctorNearMe Care DS follows the [NHS.UK design principles](https://service-manual.nhs.uk/design-system),
with visual tokens taken from the Tailwind palette the app already uses. That fits parents of young
children who are often anxious, use low-end Android phones and may read in a second language.

- **Calm, not clinical.** Teal brand on white and slate, coral only as an accent, red only for danger.
- **One task per screen** on mobile (390 px): one big primary button and 44 px minimum touch targets.
- **Plain words** (around reading age 9). Hindi and Telugu use the same layouts, and nothing depends
  on how long the English text is.
- **The AI is visible and reversible.** Voice and AI steps always show what is happening, which
  permission allows it, and a way out ("Stop", "Talk to a person", or 108/112 for red flags).
- **The clinician decides.** AI suggestions in the provider workspace stay drafts until the clinician
  confirms them.
- **Desktop for providers and admin** (1440 px, dense tables). **Mobile first for families and public pages.**

Typefaces: **Noto Sans** for the UI (plus Noto Sans Devanagari and Telugu) and **Instrument Serif** for
display headlines only. Icons: **Lucide** (MIT), 24 px, 2 px stroke.

## 3. Tokens → Tailwind

Figma has three variable collections:

- **Primitives:** the raw palette, hidden from the pickers.
- **Color:** semantic tokens, mode Light.
- **Dimension:** spacing, radius and touch target.

Each variable's code syntax holds the CSS variable (for example `var(--color-teal-700)`), so Dev Mode
shows the real token.

| Figma token | Primitive | Tailwind |
|---|---|---|
| `bg/canvas` · `bg/subtle` · `bg/muted` | white · slate/50 · slate/100 | `bg-white` · `bg-slate-50` · `bg-slate-100` |
| `bg/inverse` | slate/900 | `bg-slate-900` |
| `bg/brand` · `bg/brand-hover` | teal/700 · teal/800 | `bg-teal-700` · `hover:bg-teal-800` |
| `bg/brand-subtle` · `bg/brand-muted` | teal/50 · teal/100 | `bg-teal-50` · `bg-teal-100` |
| `bg/accent` · `bg/accent-subtle` | coral/500 · coral/100 | landing only: `--lp-coral` (#ef6f5e) in `components/landing/landing.css` |
| `bg/danger` · `bg/danger-subtle` | red/700 · red/50 | `bg-red-700` · `bg-red-50` |
| `bg/warning` · `bg/warning-subtle` | amber/500 · amber/50 | `bg-amber-500` · `bg-amber-50` |
| `bg/success` · `bg/success-subtle` | emerald/600 · emerald/50 | `bg-emerald-600` · `bg-emerald-50` |
| `bg/info-subtle` · `bg/control-off` | sky/50 · slate/300 | `bg-sky-50` · `bg-slate-300` |
| `text/primary` · `text/secondary` · `text/muted` · `text/disabled` | slate/900 · 700 · 500 · 400 | `text-slate-900` · `-700` · `-500` · `-400` |
| `text/brand` · `text/link` · `text/on-brand-muted` | teal/800 · teal/700 · teal/200 | `text-teal-800` · `text-teal-700` · `text-teal-200` |
| `text/danger` · `text/warning` · `text/success` · `text/info` | red/700 · amber/900 · emerald/800 · sky/900 | `text-red-700` · `text-amber-900` · `text-emerald-800` · `text-sky-900` |
| `text/accent` · `text/inverse` | coral/700 · white | (landing) · `text-white` |
| `border/default` · `border/strong` | slate/200 · slate/300 | `border-slate-200` · `border-slate-300` |
| `border/brand` · `border/brand-subtle` · `border/focus` | teal/600 · teal/200 · teal/600 | `border-teal-600` · `border-teal-200` · `ring-teal-600` |
| `border/danger` · `border/danger-strong` · `border/warning` · `border/info` | red/200 · red/600 · amber/200 · sky/200 | `border-red-200` · `border-red-600` · `border-amber-200` · `border-sky-200` |
| `space/0-5`, `space/1` … `space/16` | 2 px, 4 px … 64 px | Tailwind spacing scale (`p-0.5`, `p-1` … `p-16`) |
| `radius/sm` … `radius/full` | | `rounded-sm` · `rounded-md` · `rounded-lg` · `rounded-xl` · `rounded-2xl` · `rounded-full` |
| `size/touch-target` | 44 px | `min-h-11` |

**Text styles.** Display/XL, Display/L and Display/M italic use Instrument Serif. Heading/H1–H4,
Body/L/M/S, Label/L/M/S, Caption and Overline use Noto Sans.

**Effect styles.** Shadow/sm, Shadow/md and Shadow/lg match `shadow-sm`, `shadow-md` and `shadow-lg`.
Focus/ring matches `ring-2 ring-teal-600 ring-offset-2`.

## 4. Components

All components use variables (no hard-coded colours) and auto layout, so they grow with Hindi and
Telugu text.

| Group | Components |
|---|---|
| Core | Button (Primary/Secondary/Ghost/Danger × md/sm × Default/Disabled, optional icon) · Badge (6 tones) · Chip · Avatar · Tab item |
| Forms | Text field (Default/Focus/Error/Disabled) · Select · Checkbox · Toggle · Language switcher |
| Feedback | Alert (Info/Success/Warning/Danger) · Progress bar |
| Shell | Logo · Logo mark · Nav link · App header / Desktop (Provider, Admin) · App header / Mobile (Family, Public) · Bottom nav (Home/Children/Messages/Visits/Account) · Section header · List row |
| Domain | Provider card (with "Demo profile" badge) · Appointment card · Voice call panel (Idle/Connected) · Message bubble · Notification item · Goal card · ISAA item review · Permission row · Stat card · Table row |
| Icons | 35 Lucide icons (search, map-pin, calendar, mic, video, shield-check, stethoscope, …) |

## 5. Screens → routes

There are 66 screens, and every route below exists in `app/`.

### Public & parents (mobile 390 unless marked)

| Route | Screen | Figma |
|---|---|---|
| `/` | Landing (desktop) | [12:11](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=12-11) |
| `/find` | Find near me | [12:164](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=12-164) |
| `/p/[slug]` | Provider profile | [12:319](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=12-319) |
| `/book/[profileId]` | Choose a time | [12:411](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=12-411) |
| `/book/[profileId]/pay/[appointmentId]` | Payment | [13:315](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-315) |
| `/screen` | Developmental check-in (start) | [13:391](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-391) |
| `/screen` | In the call | [13:452](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-452) |
| `/screen` | Safety stop (red flag) | [13:501](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-501) |
| `/screen` | Your result | [13:570](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-570) |
| `/login` | Sign in | [13:621](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-621) |
| `/join` | Join as a provider | [13:659](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-659) |
| `/intake/[token]` | Parent intake call | [13:712](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=13-712) |
| `/specialist/[token]` | Referral packet (desktop) | [14:610](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-610) |
| `/book-demo` | Book a demo (desktop) | [14:695](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-695) |
| `/find` | Voice booking (sheet) | [14:738](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-738) |
| `/privacy` | Privacy notice | [14:789](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-789) |
| `/invite/[token]` | Team invitation | [14:876](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-876) |
| `/claim/[token]` | Claim your profile | [14:916](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=14-916) |

### Family portal (mobile 390)

| Route | Screen | Figma |
|---|---|---|
| `/family` | Home | [15:11](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-11) |
| `/family/children` | My children | [15:190](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-190) |
| `/family/children/claim` | Use a clinic code | [15:273](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-273) |
| `/family/children/[id]` | Child overview | [15:364](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-364) |
| `/family/children/[id]/privacy` | Permissions | [15:541](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-541) |
| `/family/children/[id]/health` | Health profile | [15:639](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=15-639) |
| `/family/children/[id]/documents` | Documents | [16:605](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-605) |
| `/family/children/[id]/plan` | Therapy plan | [16:726](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-726) |
| `/family/children/[id]/home-program` | Home program | [16:819](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-819) |
| `/family/children/[id]/notes` | Session notes | [16:923](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-923) |
| `/family/children/[id]/prescriptions` | Prescriptions | [16:990](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-990) |
| `/family/children/[id]/ask` | Ask about my child | [16:1078](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=16-1078) |
| `/family/messages` | Messages | [17:1049](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1049) |
| `/family/messages/[threadId]` | Conversation | [17:1131](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1131) |
| `/family/appointments` | Visits | [17:1213](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1213) |
| `/family/appointments/[id]/reschedule` | Reschedule | [17:1306](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1306) |
| `/family/appointments/[id]/rate` | Rate your visit | [17:1386](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1386) |
| `/family/notifications` | Notifications | [17:1463](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1463) |
| `/family/settings` | Account | [17:1572](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1572) |
| `/family/assessments/[id]` | Questionnaire | [17:1709](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=17-1709) |

### Provider workspace (desktop 1440)

| Route | Screen | Figma |
|---|---|---|
| `/dashboard` | Cases | [18:11](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=18-11) |
| `/cases/[id]` | Overview | [18:158](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=18-158) |
| `/cases/[id]/brief` | Pre-session brief | [18:338](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=18-338) |
| `/cases/[id]/sessions` | Sessions | [18:482](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=18-482) |
| `/cases/[id]/sessions/[recordingId]` | Session review (ISAA) | [19:382](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=19-382) |
| `/cases/[id]/report` | Assessment report | [19:618](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=19-618) |
| `/cases/[id]/referral` | Referral | [19:763](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=19-763) |
| `/cases/[id]/goals` | IEP goals | [19:893](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=19-893) |
| `/cases/[id]/home-program` | Home program | [20:801](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-801) |
| `/cases/[id]/prescriptions` | Prescriptions | [20:952](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-952) |
| `/cases/[id]/team` | Care team & sharing | [20:1103](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-1103) |
| `/cases/[id]/consent/paper` | Record paper consent | [20:1250](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-1250) |
| `/cases/[id]/assessments` | Assessments | [20:1413](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-1413) |
| `/cases/[id]/messages` | Messages | [20:1538](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=20-1538) |
| `/cases/[id]/documents` | Documents | [21:1797](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1797) |
| `/cases/[id]/shared` | Shared with us | [21:1926](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1926) |
| `/dashboard/schedule` | Schedule & availability | [21:1371](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1371) |
| `/dashboard/profile` | Public profile & verification | [21:1485](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1485) |
| `/dashboard/team` | Organisation team | [21:1613](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1613) |
| `/dashboard/settings/integrations` | Google Calendar & Meet | [21:1713](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=21-1713) |

### Admin (desktop 1440)

| Route | Screen | Figma |
|---|---|---|
| `/admin/verifications` | Verification queue | [22:11](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-11) |
| `/admin/providers` | Providers & seeding | [22:148](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-148) |
| `/admin/users` | User accounts | [22:252](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-252) |
| `/admin/notifications` | Notifications outbox | [22:324](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-324) |
| `/admin/privacy/requests` | Privacy requests | [22:422](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-422) |
| `/admin/ratings` | Ratings moderation | [22:514](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-514) |
| `/admin/ops` | Operations health | [22:580](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-580) |
| `/admin/audit` | Audit log | [22:651](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=22-651) |

## 6. How the product fits together

The [FigJam board](https://www.figma.com/board/RfeKYhTAT8MDj5kMbG7hfy) has three diagrams: the family journey,
the clinician workflow, and the **centre-invited family and money flow** (planned tickets 043–047; the parent
pays the centre, and the centre pays DoctorNearMe a platform fee per consultation, see
[decision record](../specs/grill/doctornearme-mvp.md) decision 8).

**Family journey: Discover → Book → Prepare → Ongoing care.**

1. **Discover.** Landing page, then the voice check-in (`/screen`). A red flag stops the call and
   shows 108/112. Otherwise the result leads to **Find near me** (`/find`), as a list plus map or through
   the voice booking sheet.
2. **Book.** Provider profile → pick a slot (held for 15 minutes) → sign in with Google or a phone code
   → pay with Razorpay for online services → confirmed. Confirmations go out through the outbox
   (in-app, email and WhatsApp).
3. **Prepare.** Permissions (digital, per feature, or paper consent recorded by the centre) → AI intake
   call from the appointment link → a brief for the clinician.
4. **Ongoing care.** The visit happens at the clinic or on Google Meet (a Google account is required).
   After that the family sees:
   - the therapy plan and goals
   - the home program (practice logs feed back into the plan)
   - session notes and prescriptions
   - "Ask about my child", messages and ratings

**Clinician workflow.**

1. A case comes from a booking or is created by hand.
2. The parent gets an intake link and does the intake call; the clinician reviews the brief.
3. The clinician records the session. A **consent check** runs first: if consent is missing, the
   clinician asks the parent or records paper consent.
4. The recording is transcribed and AI suggests answers; the clinician confirms the ISAA items.
5. The clinician writes the final report, then:
   - refers to a specialist (`/specialist/[token]` with "Ask the case")
   - publishes the plan, goals and home program
   - signs a prescription (verified prescribers only)

Everything published shows up in the **family portal**.

**Admin.**

- Verifies providers. For OTs, physios, ABA therapists and special educators, the admin's judgement is
  the verification.
- Seeds profiles and sends claim links.
- Watches the notifications outbox, privacy requests, ratings moderation, ops health and the audit log.

## 7. Known gaps between Figma and code

- **Primary button colour.** Figma uses teal (`bg/brand`). About 36 files in `app/` and `components/`
  still use `bg-slate-900` for primary actions, from the CareThread era. Move them to `bg-teal-700` when
  you next touch those screens.
- **Dark mode.** Not designed. The Color collection has only a Light mode, so add a Dark mode there first.
- **Hindi and Telugu.** Not mocked separately. The layouts use auto layout and the Noto fonts are loaded,
  but check the strings on the real screens.
- **Demo content.** Screens use fictional children and providers (for example "Ravi"). Never put real
  patient data in Figma.
- **Code Connect.** Not set up yet, so Figma components match code by name only.

## 8. Feature documentation map

| Area | Docs |
|---|---|
| Platform | [system-design](system-design.md) · [team-workflow](team-workflow.md) · [i18n](i18n.md) |
| Families | [guardian-auth](guardian-auth.md) · [consent](consent.md) · [health-profile](health-profile.md) · [documents](documents.md) · [sharing](sharing.md) |
| Directory and booking | [providers](providers.md) · [maps](maps.md) · [booking](booking.md) · [payments](payments.md) · [google-meet](google-meet.md) · [ratings](ratings.md) · [pilot-seeding](pilot-seeding.md) |
| Clinical | [assessments](assessments.md) · [scribe](scribe.md) · [iep](iep.md) · [home-program](home-program.md) · [prescriptions](prescriptions.md) · [messaging](messaging.md) · [notifications](notifications.md) |
| Voice agents | [screen](elevenlabs-screen-agent.md) · [intake](elevenlabs-agent.md) · [generic intake](elevenlabs-generic-intake-agent.md) · [booking](elevenlabs-booking-agent.md) · [follow-up](elevenlabs-followup-agent.md) |
| Privacy | [processors](privacy/processors.md) · [retention](privacy/retention.md) · [incident response](privacy/incident-response.md) |
