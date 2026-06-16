"use client";

/**
 * useSpeechRecognition — thin React wrapper over the browser's native
 * SpeechRecognition API (Chrome/Edge/Safari). No server dependency, no
 * audio upload, no API key — the browser does on-device transcription
 * and we just receive text events.
 *
 * Why this over Whisper:
 *   - Zero cost, zero latency, zero new env vars.
 *   - Multilingual via `lang` (e.g. "en-US", "es-ES", "fr-FR").
 *   - Works while the user is online; falls back gracefully when the
 *     API is missing (Firefox, old Safari) — callers should hide their
 *     mic button when `supported === false`.
 *
 * Surface:
 *   - state: "idle" | "listening" | "error"
 *   - error: human-readable message when state === "error"
 *   - interim: partial transcript as the user speaks (for live preview)
 *   - start(): begin listening; emits onResult on each final segment
 *   - stop():  end listening
 *   - supported: boolean — true if the browser exposes the API
 *
 * Failure modes handled:
 *   - Permission denied → state = "error", error explains how to fix
 *   - Network errors / no-speech → silently reset to idle
 *   - Double start() → ignored (already listening)
 *   - Component unmount mid-listen → instance is aborted cleanly
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Browser type shims ───────────────────────────────────────────────
// SpeechRecognition isn't in TS DOM lib defaults across all targets.
// Keep these LOCAL to avoid polluting global types.

type RecognitionAlternative = { transcript: string; confidence: number };
type RecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
};
type RecognitionResultList = {
  length: number;
  [index: number]: RecognitionResult;
};
type RecognitionEvent = {
  resultIndex: number;
  results: RecognitionResultList;
};
type RecognitionErrorEvent = {
  error: string;
  message?: string;
};
type RecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionCtor = new () => RecognitionInstance;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── Public API ────────────────────────────────────────────────────────

export type SpeechState = "idle" | "listening" | "error";

export interface UseSpeechRecognitionOptions {
  /**
   * BCP-47 language tag. Defaults to the browser locale, which works well
   * for the demo. Override per-user later if you ship a language picker.
   */
  lang?: string;
  /**
   * Fired once per FINAL transcript segment. Callers typically append
   * the result to the chat input. Interim results are exposed via the
   * `interim` state field instead so they don't fire this callback.
   */
  onResult?: (transcript: string) => void;
}

export interface UseSpeechRecognitionReturn {
  supported: boolean;
  state: SpeechState;
  error: string;
  interim: string;
  start: () => void;
  stop: () => void;
}

export function useSpeechRecognition(
  opts: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const supported = useMemo(() => getRecognitionCtor() !== null, []);
  const [state, setState] = useState<SpeechState>("idle");
  const [error, setError] = useState<string>("");
  const [interim, setInterim] = useState<string>("");
  const recRef = useRef<RecognitionInstance | null>(null);
  // Latest onResult — kept in a ref so we don't have to rebuild the
  // recognition instance whenever the parent re-renders.
  const onResultRef = useRef<typeof opts.onResult>(opts.onResult);
  useEffect(() => { onResultRef.current = opts.onResult; }, [opts.onResult]);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("Speech recognition isn't available in this browser. Try Chrome, Edge, or Safari.");
      setState("error");
      return;
    }
    if (recRef.current) {
      // Already listening — second click is a no-op. Use stop() to cancel.
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = opts.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
      rec.continuous = false;       // single utterance per click — clearer UX
      rec.interimResults = true;    // stream partials so the user sees progress
      rec.maxAlternatives = 1;

      rec.onstart = () => {
        setState("listening");
        setError("");
        setInterim("");
      };

      rec.onresult = (e: RecognitionEvent) => {
        let interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r[0]?.transcript ?? "";
          if (r.isFinal) {
            const cleaned = text.trim();
            if (cleaned) onResultRef.current?.(cleaned);
          } else {
            interimText += text;
          }
        }
        setInterim(interimText);
      };

      rec.onerror = (e: RecognitionErrorEvent) => {
        // "no-speech" and "aborted" aren't real errors — the user just
        // didn't say anything, or they cancelled. Quietly reset.
        if (e.error === "no-speech" || e.error === "aborted") {
          return;
        }
        const msg =
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "Microphone permission denied. Allow it in your browser settings to use voice input."
            : e.error === "audio-capture"
              ? "No microphone detected. Check that your mic is plugged in and selected."
              : `Voice input error: ${e.error}${e.message ? ` (${e.message})` : ""}`;
        setError(msg);
        setState("error");
      };

      rec.onend = () => {
        recRef.current = null;
        setInterim("");
        // Only revert to idle if we weren't bumped to "error" by onerror.
        setState((prev) => (prev === "error" ? "error" : "idle"));
      };

      recRef.current = rec;
      rec.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Could not start voice input: ${msg}`);
      setState("error");
      recRef.current = null;
    }
  }, [opts.lang]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // ignore — onend will null the ref
    }
  }, []);

  // Always abort on unmount so a page nav mid-utterance doesn't leak
  // the mic indicator or fire callbacks against unmounted state.
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (rec) {
        try { rec.abort(); } catch { /* ignore */ }
        recRef.current = null;
      }
    };
  }, []);

  return { supported, state, error, interim, start, stop };
}
