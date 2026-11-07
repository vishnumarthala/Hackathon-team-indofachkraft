"""Parse synthetic-cases.md into synthetic-cases.json for batch TTS / pipeline tests.
Usage: python3 docs/script/build_cases_json.py
"""
import json, re, pathlib

here = pathlib.Path(__file__).parent
md = (here / "synthetic-cases.md").read_text()
VOICE = {"CareThread AI": "A", "Therapist": "B", "Parent": "C", "Specialist": "D"}
SPEAKER = {"CareThread AI": "ai_agent", "Therapist": "therapist", "Parent": "parent", "Specialist": "specialist"}

cases = []
for block in re.split(r"^## Case ", md, flags=re.M)[1:]:
    head = block.splitlines()[0]
    num, title = head.split(":", 1)
    meta = re.search(r"\*\*Synthetic patient:\*\* (.+?) \| \*\*Parent:\*\* (.+?) \| \*\*Clinician:\*\* (.+)", block)
    routing = re.search(r"\*\*Expected routing:\*\* (.+)", block).group(1).strip()
    phases = {}
    for ph in re.split(r"^### ", block, flags=re.M)[1:]:
        name = ph.splitlines()[0].strip()
        key = "phase1_intake" if name.startswith("Phase 1") else "phase2_session" if name.startswith("Phase 2") else "phase3_handoff"
        turns = []
        for spk, text in re.findall(r"^\*\*(CareThread AI|Therapist|Parent|Specialist):\*\* (.+)$", ph, flags=re.M):
            t = {"speaker": SPEAKER[spk], "voice": VOICE[spk], "text": text.strip()}
            notes = re.findall(r"rate item (\d+) as (\d)", text)
            if notes:
                t["therapist_notes"] = [{"item_id": int(i), "rating": int(r)} for i, r in notes]
            turns.append(t)
        phases[key] = {"title": name, "turns": turns}
    child = meta.group(1)
    cases.append({
        "case_id": f"case-{int(num)}",
        "title": title.strip(),
        "child": child.split(",")[0].strip(),
        "child_age": child.split(",", 1)[1].strip(),
        "parent": meta.group(2).strip(),
        "clinician": meta.group(3).strip(),
        "expected_routing": routing,
        "isaa_total_expected": int(m.group(1)) if (m := re.search(r"(?:scored |ISAA (?:score )?is )(\d{2,3})", " ".join(t["text"] for t in phases["phase3_handoff"]["turns"]))) else None,
        **phases,
    })

out = {
    "note": "Synthetic cases only. No real patient data. Pause 0.5 s between turns for clean diarization.",
    "voices": {"A": "CareThread AI agent", "B": "Therapist", "C": "Parent", "D": "Specialist"},
    "cases": cases,
}
(here / "synthetic-cases.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(f"wrote {len(cases)} cases")
