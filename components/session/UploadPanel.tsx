"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  NETWORK_ERROR,
  STEP_ORDER,
  newProgress,
  postJson,
  runFlow,
  validateAudioFile,
  type FlowDeps,
  type FlowProgress,
  type StepId,
  type StepState,
} from "./uploadFlow";

const STEP_LABELS: Record<StepId, string> = {
  upload: "Upload",
  transcribe: "Transcribe (ElevenLabs Scribe v2)",
  extract: "Fill ISAA form (Gemini)",
};

const STATE_LABELS: Record<StepState, string> = {
  waiting: "Waiting",
  running: "Running…",
  done: "Done",
  failed: "Failed",
};

type Steps = Record<StepId, { state: StepState; error: string | null }>;

const initialSteps = (): Steps => ({
  upload: { state: "waiting", error: null },
  transcribe: { state: "waiting", error: null },
  extract: { state: "waiting", error: null },
});

const deps: FlowDeps = {
  post: postJson,
  async uploadToSignedUrl(path, token, file, contentType) {
    try {
      const { error } = await supabaseBrowser().storage.from("recordings").uploadToSignedUrl(path, token, file, { contentType });
      return { error: error ? { message: error.message } : null };
    } catch (err) {
      return { error: { message: err instanceof Error && err.message ? err.message : NETWORK_ERROR } };
    }
  },
};

export function UploadPanel({ caseId }: { caseId: string }) {
  const router = useRouter();
  const progress = useRef<FlowProgress>(newProgress());
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Steps>(initialSteps);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);

  const failedStep = STEP_ORDER.find((id) => steps[id].state === "failed");

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    setFileError(chosen ? validateAudioFile(chosen) : null);
    // A new file means a new session: forget what the previous attempt had done.
    progress.current = newProgress();
    setSteps(initialSteps());
    setStarted(false);
  }

  async function run() {
    if (!file) return;
    setRunning(true);
    setStarted(true);
    const result = await runFlow({
      caseId,
      file,
      progress: progress.current,
      deps,
      onStep: (step, state, error) =>
        setSteps((current) => ({ ...current, [step]: { state, error: state === "failed" ? (error ?? null) : null } })),
    });
    if (result.ok) {
      router.push(`/cases/${caseId}/sessions/${result.recordingId}`);
      return;
    }
    setRunning(false);
  }

  function onStart() {
    if (!file) return;
    const problem = validateAudioFile(file);
    setFileError(problem);
    if (problem) return;
    void run();
  }

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <label htmlFor="session-recording" className="block text-sm font-medium text-slate-800">
          Session recording
        </label>
        <input
          id="session-recording"
          type="file"
          accept="audio/*"
          disabled={running}
          onChange={onFile}
          className="mt-1 block w-full text-sm"
        />
        {fileError && (
          <p role="alert" className="mt-1 text-sm text-red-700">
            {fileError}
          </p>
        )}
      </div>

      <div className="flex items-start gap-2">
        <input
          id="session-consent"
          type="checkbox"
          checked={consent}
          disabled={running}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1"
        />
        <label htmlFor="session-consent" className="text-sm text-slate-800">
          The parent consented to recording this session
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!file || !consent || running || started}
          onClick={onStart}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Upload and process
        </button>
        {failedStep && !running && (
          <button
            type="button"
            onClick={() => void run()}
            className="rounded border border-slate-400 px-4 py-2 text-sm font-medium text-slate-900"
          >
            Retry
          </button>
        )}
      </div>

      <ol aria-label="Progress" className="divide-y divide-slate-200 rounded border border-slate-200">
        {STEP_ORDER.map((id) => {
          const step = steps[id];
          return (
            <li key={id} data-step={id} data-state={step.state} className="px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-slate-900">{STEP_LABELS[id]}</span>
                <span className={step.state === "failed" ? "font-semibold text-red-700" : "text-slate-700"}>
                  {STATE_LABELS[step.state]}
                </span>
              </div>
              {step.error && (
                <p role="alert" className="mt-1 text-red-700">
                  {step.error}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
