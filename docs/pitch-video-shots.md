# CareThread pitch video: 3-minute shot list

Goal: convey the problem, how our ElevenLabs voice agent and Gemini solve it, and who pays. The screens
only need to look real; every shot below uses synthetic demo data that looks the same in every take.

## Before you record (5 minutes)

1. `npm run dev -- -p 3000`, open `http://localhost:3000` in a clean browser window at **1440×900**
   (or 1280×800), zoom 100 %, bookmarks bar hidden, notifications off.
2. In a second tab, **sign in** (`/login`) with your team account so the case pages open without a redirect.
3. Seed a fresh case for the product shots: `npm run -s seed:demo -- --new --confirmed`, then copy the
   `case=` and `session=` IDs from the last line (or use the canonical demo case if the captain seeded it).
4. Pre-open these tabs in this order: landing `/`, the case's **Sessions → Session 1**, **Report**,
   **Referral**, and the specialist link (created on the Referral tab).
5. Use headphones for the voice-over. Speak slowly; 3 minutes is about 400 words.

## Shots

| Time | Screen and action | Voice-over (suggested) |
|------|-------------------|------------------------|
| **0:00–0:20** | Landing, top: CareThread hero. Scroll slowly to **"The signs appear at 2. Help arrives at 4 to 6."** | "Parents notice the first signs of autism at about two. But help arrives at four to six: in Germany the average is six and a half. The window where support helps most closes before three. Why so late? Too few specialists, year-long waitlists, and therapists who spend their sessions on paperwork." |
| **0:20–0:45** | Click **Hear the AI intake call**. In the card, press play on **Listen to a sample call**: let the AI disclosure and two answers play (the line being spoken highlights). | "CareThread starts before the first visit. The parent gets a link and talks to our ElevenLabs voice agent, in Telugu, Hindi or English. It says it's an AI, asks for consent, and asks one question at a time." |
| **0:45–1:10** | Scroll to **What the therapist sees after the call**. Click the **▶** on the *Lost speech* red flag (audio jumps to that moment). Click **Confirm** on two answers. | "The therapist doesn't get a recording to listen to for an hour. She gets a brief: red flags in the parent's own words, one click to hear the moment, every answer ready to confirm, and the questions to check in session one." |
| *(optional, 10 s)* | **Talk to it live** tab: tick the box, **Start demo call**, say "Yes, that's fine", let the agent ask the first question, **End call**. The page scrolls to the therapist view. | "This is the real agent, live." |
| **1:10–1:50** | Product tab: **Sessions → Session 1** review screen. Click an item's evidence play button (the session audio plays at the quote). Show the confirmed items and the score panel. | "During the session, the form fills itself: all 40 ISAA items, each with a suggested rating, a quote and a timestamp from the recording. The therapist confirms or edits every item. The score only counts what she confirmed." |
| **1:50–2:15** | **Report** tab: show the draft report, then **Mark final** and the Telugu voice note section. | "A draft report is ready the same day, and parents get a short voice summary in their own language." |
| **2:15–2:40** | **Referral** tab, then the specialist page: type **"When did speech regress?"** in **Ask the case**; show the answer with its timestamp citation. | "When it's serious, one click sends the full case to the specialist, who can ask it questions and gets answers with the exact moment in the session. The family never repeats the story." |
| **2:40–3:00** | Landing: **Four people, one thread**, then **Join the pilot**. | "Centres pay per clinician; families and specialists use it free. We start with three pilot centres from our network in India and Germany. AI documents, the clinician decides. CareThread." |

## Tips

- Record each block as a separate take and cut them together; it is easier than one perfect run.
- Cursor movements slow and deliberate; pause half a second before each click.
- If the live call is unreliable in the venue, skip the optional shot: the sample call and therapist
  view tell the same story.
- Everything shown is synthetic role-play data (Ravi, Lakshmi, Demo Therapist). Do not show the
  ElevenLabs or Supabase dashboards or any keys on screen.
