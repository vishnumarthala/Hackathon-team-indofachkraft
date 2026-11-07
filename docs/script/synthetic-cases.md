# Synthetic patient cases: all three phases

Six synthetic cases modelled on the interview patterns of standardized assessments (ISAA, ADI-R, DSM-5 caregiver interviews). Together they cover the severity bands and red flags. Each case has three parts:

- **Phase 1:** AI intake call
- **Phase 2:** online assessment session
- **Phase 3:** specialist handoff

Use them for TTS audio generation, pipeline testing and the demo. **All names are synthetic. No real patient data.**

| # | Child | Band | Red flags | Expected routing |
|---|---|---|---|---|
| 1 | Aarav, 3.5 | Severe (ISAA 162) | Speech regression, self-injury | Immediate specialist referral (Phase 3) |
| 2 | Kabir, 4 | Moderate (ISAA 124) | None | IEP and regular therapy sessions |
| 3 | Diya, 5 | Mild (ISAA 82, FACP 68) | None | IEP, home program, 3-month review |
| 4 | Rohan, 4.5 | Severe (ISAA 171) | Lack of fear of danger, elopement, pain insensitivity | Specialist referral (Phase 3) |
| 5 | Maya, 3 | No autism (ISAA 48, FACP 86) | None | Home program, parent counselling, 3-month re-screen |
| 6 | Leo, 4 | Moderate (ISAA 145) | Severe communication delay | Structured therapy and specialist review (SPZ) |

A machine-readable version for batch TTS is in [`synthetic-cases.json`](synthetic-cases.json). Run `python3 docs/script/build_cases_json.py` to regenerate it after you edit this file.

---

## Case 1: Severe band, dual red flags (speech regression and self-injury)

- **Synthetic patient:** Aarav, 3.5 years | **Parent:** Ananya | **Clinician:** Dr. Sharma
- **Expected routing:** ISAA > 153 (Severe) + red flags → immediate specialist referral (Phase 3)

### Phase 1: AI intake call

**CareThread AI:** Hello Ananya. I am CareThread, an AI assistant calling on behalf of Dr. Sharma's Early Intervention Centre before Aarav's visit tomorrow. With your consent, may I ask a few quick questions to prepare your brief?
**Parent:** Yes, go ahead.
**CareThread AI:** What is your main concern about Aarav right now?
**Parent:** He said a few words like "Mama" and "ball" at age two, and then he completely stopped talking. Also, he never turns when we call his name.
**CareThread AI:** I've noted that speech stopped after age two and he doesn't respond to his name. Does he ever hurt himself when upset?
**Parent:** Yes, when frustrated, he hits his own head with his hand.
**CareThread AI:** Thank you. I've marked these as parent-reported for Dr. Sharma's review before tomorrow.

### Phase 2: Online assessment session

**Therapist:** Thank you for consenting to recording, Ananya. Tell me how Aarav interacts and plays at home.
**Parent:** He does not look at us when we talk, his eyes dart away. He plays completely alone, lines up toy cars by color, and refuses to play with his cousins. He repeats lines from cartoons instead of talking, and never points to show us things; he just drags my hand to the kitchen.
**Therapist:** Note: child did not respond to name in three attempts during live observation, rate item 5 as 4. How does he react to noise or changes?
**Parent:** He covers his ears at the mixer and pressure cooker, flaps his hands when excited, and has a massive tantrum if we change the route to school, hitting his own head until I hold his hands down.
**Therapist:** Note: clear speech regression and self-injurious behavior observed, rate item 29 as 4. Let's do a quick guided play observation on camera now.

### Phase 3: Specialist handoff (live clinician-to-specialist call)

**Therapist:** Dr. Nair, I'm sending over Aarav's referral packet. His ISAA score is 162, putting him in the severe band, with two red flags: speech regression after 24 months and head-hitting during transitions.
**Specialist:** I see the timestamped clips in CareThread. Did he show any joint attention or pointing during your live camera observation?
**Therapist:** None at all. Zero pointing and zero response to name across three trials. The parent has consented to share the full case memory, so you can query any item directly.

---

## Case 2: Moderate band (sensory seeking, echolalia and rigid routines)

- **Synthetic patient:** Kabir, 4 years | **Parent:** Vikram | **Clinician:** Dr. Meera
- **Expected routing:** ISAA 107–153 (Moderate), FACP 40–59 → IEP and regular therapy sessions

### Phase 1: AI intake call

**CareThread AI:** Hello Vikram. I am CareThread, an AI assistant calling before Kabir's session tomorrow. With your consent, I'd like to gather a brief summary for Dr. Meera. Is now okay?
**Parent:** Yes, sure.
**CareThread AI:** What prompted you to book this evaluation for Kabir?
**Parent:** His preschool teachers noticed he doesn't sit with other kids, talks mostly by repeating movie dialogues, and gets extremely upset if his daily routine changes.
**CareThread AI:** Got it. Any concerns with self-injury or loss of previously learned speech?
**Parent:** No, he hasn't lost speech and doesn't hurt himself, though he does spin in circles a lot.
**CareThread AI:** Thank you, Vikram. All details are marked parent-reported for Dr. Meera.

### Phase 2: Online assessment session

**Therapist:** Hi Vikram, with your permission we're recording so CareThread can draft our assessment notes. Tell me about Kabir's communication and play.
**Parent:** He talks, actually quite a lot, but it's almost all echolalia. He repeats exact commercial jingles or uses a sing-song monotone voice. He doesn't maintain peer relationships and prefers spinning the wheels of his bicycle upside down for an hour.
**Therapist:** Note: prominent echolalia and preoccupation with spinning parts of objects, rate item 24 as 4. What about sensory behaviors or meals?
**Parent:** He has a super selective diet, only eats white rice and plain crackers, and refuses clothes with tags. He also walks on his tiptoes constantly and stares at ceiling fans out of the corner of his eye.
**Therapist:** Note: persistent toe-walking and tactile defensiveness noted, rate item 31 as 4.

### Phase 3: Specialist handoff (developmental pediatrician consult)

**Therapist:** Dr. Rao, Kabir scored 124 on the ISAA, moderate band. No red flags, so we've started an IEP with speech and occupational therapy, and I'm sharing his profile for a co-occurring ADHD and sensory evaluation.
**Specialist:** Looking at the CareThread timeline, his eye contact and reciprocal conversation are the lowest-scoring domains. Let's review him in six weeks after his OT sensory diet begins.

---

## Case 3: Borderline / mild band (high-functioning social and pragmatic delays)

- **Synthetic patient:** Diya, 5 years | **Parent:** Sneha | **Clinician:** Dr. Kavita
- **Expected routing:** ISAA 70–106 (Mild), FACP 60–79 → IEP, home program and 3-month review

### Phase 1: AI intake call

**CareThread AI:** Hello Sneha. I am CareThread, an AI assistant calling on behalf of Dr. Kavita's clinic. With your consent, may I ask three brief questions before Diya's appointment?
**Parent:** Yes, of course.
**CareThread AI:** What behaviors would you like Dr. Kavita to focus on tomorrow?
**Parent:** Diya is very bright and knows all the capitals of the world, but she doesn't understand personal space, takes everything literally, and struggles to make friends at school.
**CareThread AI:** Understood. Does she have any sensory sensitivities or meltdown triggers?
**Parent:** Loud school assemblies and hand dryers make her panic and cover her ears.
**CareThread AI:** Thank you. I've added this to Diya's pre-session brief.

### Phase 2: Online assessment session

**Therapist:** Welcome Sneha. Let's talk through how Diya interacts with peers and handles emotions.
**Parent:** She wants friends, so she's not aloof, but she talks at kids about train schedules instead of taking turns in conversation. She doesn't pick up on facial expressions when someone is bored or annoyed.
**Therapist:** Note: one-sided social approach and difficulty reading social cues, rate item 6 as 3. How does she handle unexpected changes?
**Parent:** If a substitute teacher comes to class, she cries inconsolably because her mental rulebook is broken. She also has an unusual memory for dates and license plates, though she struggles to focus on simple homework instructions.
**Therapist:** Note: circumscribed interest and rigid adherence to rules, rate item 39 as 4.

### Phase 3: Specialist handoff (school psychologist alignment)

**Therapist:** Dr. Menon, Diya scored 82 on the ISAA, mild band, and 68 on the FACP. I'm sharing her CareThread brief with you so her school IEP includes pragmatic social-skills group therapy and noise-canceling accommodations for assemblies.
**Specialist:** This evidence log makes the school accommodation request straightforward. We'll re-screen her in three months.

---

## Case 4: Severe band + elopement / lack of fear of danger (red flag)

- **Synthetic patient:** Rohan, 4.5 years | **Parent:** Rajesh | **Clinician:** Dr. Sharma
- **Expected routing:** ISAA > 153 (Severe) + safety red flag → specialist referral (Phase 3)

### Phase 1: AI intake call

**CareThread AI:** Hello Rajesh. I am CareThread, an AI assistant calling before Rohan's first assessment. With your consent, can I ask a few quick intake questions?
**Parent:** Yes, please.
**CareThread AI:** What is your biggest daily challenge with Rohan?
**Parent:** He doesn't speak at all, doesn't respond to his name, and has zero fear of danger. He ran straight into traffic twice last month without looking back.
**CareThread AI:** I'm flagging safety awareness and non-verbal communication as high priority for Dr. Sharma. Thank you for sharing.

### Phase 2: Online assessment session

**Therapist:** Thank you for joining, Rajesh. Tell me more about Rohan's safety awareness and sensory responses.
**Parent:** He has no fear of heights or moving cars, and he seems completely insensitive to pain. Last week he fell and scraped his knee badly and didn't even flinch or cry. He also smells and licks toys before holding them.
**Therapist:** Note: marked lack of fear of danger and high pain threshold, rate item 13 as 5 and item 35 as 5. How does he communicate hunger or discomfort?
**Parent:** He screams or throws sudden temper tantrums for no apparent reason, and stares into space for long stretches while rocking back and forth.
**Therapist:** Note: frequent body rocking and non-verbal distress behaviors, rate item 24 as 5.

### Phase 3: Specialist handoff (pediatric neurologist referral)

**Therapist:** Dr. Verma, I'm referring Rohan urgently. His ISAA is 171, severe band, and his complete lack of pain response and elopement risk require a pediatric neurology and behavioral safety evaluation.
**Specialist:** I have his CareThread packet open now, including the parent's quotes on pain insensitivity. I'll prioritize his slot this week.

---

## Case 5: Typical / non-autism band (speech delay only, re-screen)

- **Synthetic patient:** Maya, 3 years | **Parent:** Pooja | **Clinician:** Dr. Meera
- **Expected routing:** ISAA < 70 (No autism), FACP ≥ 80 → home program, parent counselling and 3-month re-screen

### Phase 1: AI intake call

**CareThread AI:** Hello Pooja. I am CareThread, an AI assistant calling before Maya's appointment tomorrow. With your consent, may I ask a few questions to prepare Dr. Meera?
**Parent:** Yes, sure.
**CareThread AI:** What concerns brought you to the centre?
**Parent:** Maya only says about ten single words at age three, so we are worried about autism.
**CareThread AI:** Does she make eye contact, point to show you things, and play with other kids?
**Parent:** Oh yes, she points at dogs outside, brings us toys to share, waves bye-bye, and loves playing peek-a-boo with her brother.
**CareThread AI:** Thank you, Pooja. I've logged those strengths and your speech concerns for Dr. Meera.

### Phase 2: Online assessment session

**Therapist:** Hi Pooja, I read your intake brief. Let's verify Maya's social reciprocity and play behaviors today.
**Parent:** She smiles back whenever we smile, comes to us for hugs when she's hurt, and pretends to feed her doll with a spoon. She understands everything we say. If I ask her to bring her blue shoes, she gets them right away. She just isn't putting two words together yet.
**Therapist:** Note: strong joint attention, pretend play, and receptive language; social items rated 1 across the board. Any repetitive movements or sensory aversions?
**Parent:** None at all. No hand flapping, no lining up toys, and normal reactions to sounds and food.
**Therapist:** Note: absence of restricted or repetitive behaviors; total ISAA score is 48, below the 70 threshold.

### Phase 3: Specialist handoff (speech-language pathologist internal handoff)

**Therapist:** Hi Divya, I'm sharing Maya's CareThread summary with you for targeted speech therapy. Her ISAA is 48, no autism indicators, and her FACP is 86, so she just needs expressive speech stimulation and a three-month re-screen.
**Specialist:** Great, seeing that her receptive language and joint attention are intact lets me start directly on expressive vocabulary expansion.

---

## Case 6: Moderate-to-severe band (German SPZ cross-border / bilingual family context)

- **Synthetic patient:** Leo, 4 years | **Parent:** Karthik | **Clinician:** Dr. Weber
- **Expected routing:** ISAA 145 (Moderate) + severe communication delay → structured therapy and specialist review

### Phase 1: AI intake call

**CareThread AI:** Hello Karthik. I am CareThread, an AI assistant calling on behalf of the Autism Therapy Centre before Leo's intake. With your consent, may I ask a few questions to prepare Dr. Weber?
**Parent:** Yes, thank you. It's a relief to explain everything clearly before our appointment.
**CareThread AI:** What behaviors have you and his kindergarten noticed?
**Parent:** At kindergarten he stays completely aloof in the corner, doesn't respond when teachers call him, and gets overwhelmed by group circle time. At home he only uses single words in Tamil and English to ask for food, never to chat.
**CareThread AI:** Thank you. I've structured these observations into Dr. Weber's pre-session brief.

### Phase 2: Online assessment session

**Therapist:** Hello Karthik, thank you for consenting to recording. Let's review Leo's communication and behavior patterns at home and kindergarten.
**Parent:** He rarely makes eye contact and doesn't show a range of facial expressions. He's mostly blank unless he's frustrated. He lines up wooden blocks in exact patterns and gets agitated if his little sister touches them.
**Therapist:** Note: aloof social presentation and rigid object arrangement, rate item 3 as 4 and item 23 as 4. How does he react to sensory environments?
**Parent:** Crowded supermarkets trigger huge meltdowns where he covers his ears and drops to the floor. He also insists on drinking only from one specific blue cup.
**Therapist:** Note: auditory hypersensitivity and insistence on sameness, rate item 30 as 4.

### Phase 3: Specialist handoff (SPZ multidisciplinary team referral)

**Therapist:** Dr. Schneider, I'm transferring Leo's CareThread referral packet to the SPZ team. His ISAA score is 145, moderate band, with clear documentation across both home and kindergarten settings so the family doesn't have to repeat their history again.
**Specialist:** Having the timestamped evidence and bilingual home observations already structured saves us an entire intake appointment. We'll schedule his formal diagnostic confirmation next month.

---

## Generating audio for all 6 cases (ElevenLabs)

- Use four voices: **Voice A** for the CareThread AI, **Voice B** for the therapist, **Voice C** for the parent, **Voice D** for the specialist.
- Leave a 0.5-second pause between speaker turns. This helps Scribe v2 tell the speakers apart when you upload the files into the demo.
- Use the same voice for a role in all six cases, so the AI learns one voice per role.

## ⚠️ Fix before recording: item numbers and routing

The therapist voice notes must use the same item numbers as `schemas/isaa.json`. If they don't, the form fills the wrong items. Check these:

| Case | Voice note says | In our schema | Fix |
|---|---|---|---|
| 1 | "did not respond to name … rate **item 5**" | Item 5 = *Unable to relate to people*; response to name/cues = **item 6** | Change to item 6 |
| 6 | "rigid object arrangement … rate **item 23**" | Item 23 = *Unable to grasp pragmatics of communication* | Change to item 7 (repetitive play) or 30 (sameness) |
| 3 | "circumscribed interest and rigid adherence to rules, rate **item 39**" | Item 39 = *Unusual memory*. This matches the parent's line about dates and licence plates, but not the note's wording. | Reword the note to "unusual memory for dates and licence plates" |

Two routing questions the team needs to decide. The code follows the team plan, so the app will behave differently from what the cases expect:

1. **Referral at ISAA 70 or more.** The team plan, and `shouldRecommendReferral` in `lib/scoring.ts`, recommend referral for any ISAA score of 70 or more. Cases 2, 3 and 6 score 70 or more but expect IEP or therapy instead of a referral. Choose one:
   - Keep 70 as the threshold and change the cases' expected routing.
   - Change the threshold, for example to referral only in the Severe band or when there's a red flag.
2. **Safety red flags.** Case 4 treats "no fear of danger, runs into traffic" as a red flag. The schema only flags item 15 (lost speech) and item 29 (self-injury). If the team wants this as a red flag, add `"red_flag"` to item 13 (*lacks fear of danger*) in `schemas/isaa.json`.
