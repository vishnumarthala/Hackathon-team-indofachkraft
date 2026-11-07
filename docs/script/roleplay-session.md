# Role-play script: Phase 2 online session

Use this to record the demo audio (`demo/roleplay.mp3`). It takes about 4 minutes. Two adults, quiet room, one microphone per speaker if you can.

- **Characters (synthetic):** Therapist; parent **Ananya**; child **Aarav** (age 3, in the background)
- **Rules:** Use synthetic names only. No real patient data. Say the consent line first.
- **Therapist voice notes:** Speak them clearly and slowly. They start with "Note:".

---

**Therapist:** Hello Ananya, thank you for joining today. Before we start, I just want to confirm you are okay with this session being recorded so CareThread can help me document our notes accurately.

**Parent:** Yes, Doctor, absolutely. Anything that helps Aarav.

**Therapist:** Wonderful. I reviewed the brief from your intake call, and I can see Aarav playing in the background there. Let us go through what you are observing at home so we can complete his assessment. Tell me a bit about how he interacts with you and your family.

**Parent:** Honestly, Doctor, it has been really worrying. The main thing is he does not look at us when we talk to him. Even if I hold his face gently, his eyes just dart away. And he does not turn when we call his name. I can call Aarav five times right behind him, and nothing, he acts like he did not even hear us.

**Therapist:** Let me log that right away. *Note: child did not respond to name in three attempts during live observation, rate item 5 as 4.* Has he always been quiet, or did he speak earlier?

**Parent:** That is what breaks my heart, Doctor. He said a few words at age two, like Mama, Dada, and ball, and then he completely stopped talking around two and a half. Now he just makes humming sounds, or he repeats lines from cartoons over and over, word for word, without actually talking to us.

**Therapist:** I understand how hard that is. How does he play when other children are around, or with his toys at home?

**Parent:** He plays completely alone. Last weekend my sister's kids came over, and he did not play with his cousins at all. He just sits in the corner and lines up his toy cars in a straight line by color. If anyone moves one car, he gets very upset. Also, he does not point to show us things. If he wants water or a toy, he just grabs my hand and drags me to the kitchen.

**Therapist:** Let me record that observation as well. *Note: clear regression in speech after age two and lack of pointing or peer play, rate item 14 as 5.* What about his reactions to sounds, routines, or when he gets frustrated?

**Parent:** Oh, he is so sensitive to noise. Every morning in the kitchen, he covers his ears at the mixer and the pressure cooker and runs under the table. On the other hand, when he is really excited or watching spinning fans, he flaps his hands rapidly.

**Therapist:** And how does he handle changes in his daily schedule?

**Parent:** Any small change causes a big tantrum. For example, if we change the route to school because of traffic, he screams the entire way. And when he gets that upset or frustrated, he hits his own head with his palm until I hold his hands down. I get really scared he will hurt himself.

**Therapist:** Thank you for sharing all of that so openly, Ananya. Seeing that self-injury and the speech regression gives me a very clear picture. Let us spend the next few minutes doing a quick guided play activity with him on camera so I can observe these behaviors directly, and then we will talk through the next steps and specialist support.

**Parent:** Okay, Doctor. Let me bring his blocks closer to the camera.

---

## ISAA signs covered (what the form should fill)

| Sign in the script | ISAA item (`schemas/isaa.json`) | Red flag |
|---|---|---|
| Does not look at us, eyes dart away | 1 Poor eye contact | |
| Does not turn when name is called | 6 Unable to respond to social / environmental cues | |
| Plays alone, not with cousins | 7 Solitary play, 9 No peer relationships | |
| Said words at two, then stopped | 15 Acquired speech and lost it | ✅ |
| Humming sounds | 19 Unusual noises | |
| Repeats cartoon lines word for word | 18 Echolalia, 17 Stereotyped language | |
| Does not point, drags parent's hand | 16 Difficulty with non-verbal gestures | |
| Lines up cars by colour, upset if moved | 7 Repetitive play, 30 Insists on sameness | |
| Covers ears at mixer / pressure cooker | 31 Sensitive to sensory stimuli | |
| Flaps hands, watches spinning fans | 24 Repetitive motor mannerisms | |
| Tantrum when route changes | 28 Temper tantrums, 30 Insists on sameness | |
| Hits own head when upset | 29 Self-injurious behaviour | ✅ |

> ⚠️ **Item numbers in the voice notes:** In our schema, "does not respond to name" is item **6** and "speech regression" is item **15**. The script says item 5 and item 14. Fix this before recording. Either change the script, or check the official ISAA sheet and update `schemas/isaa.json` to match. The voice notes and the schema must use the same numbers, or the form will fill the wrong items.
