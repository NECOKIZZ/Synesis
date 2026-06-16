"use client";

/**
 * MicButton — single voice-input affordance for the chat composer.
 *
 * Behaviour:
 *   - Idle:       mic icon, click to start listening.
 *   - Listening:  red pulsing icon, click again to stop.
 *   - Unsupported: component renders nothing (Firefox, locked-down
 *                  browsers). Callers don't need to gate themselves.
 *   - Error:      surfaces the error via `onError` so the parent can
 *                 show it in its existing error UI rather than a tooltip.
 *
 * Integration contract:
 *   - `onTranscript(text)` is called once per FINAL utterance. Parents
 *     typically append to the current input value with a leading space
 *     if the field is non-empty.
 *   - `interim` partials stream to `onInterim?` (optional, lets the
 *     parent show "…hearing: send 5 to ma…" inline).
 *
 * Keep this component dumb: it owns no chat state, just the
 * microphone affordance. Hook lives in lib/voice/.
 */

import { useEffect } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { useSpeechRecognition } from "@/lib/voice/use-speech-recognition";

export interface MicButtonProps {
  /** Called once per final transcript chunk. */
  onTranscript: (text: string) => void;
  /** Optional: stream interim transcripts as the user speaks. */
  onInterim?: (text: string) => void;
  /** Optional: surface errors (permission denied etc.) up to the parent. */
  onError?: (message: string) => void;
  /** BCP-47 language tag. Defaults to the browser locale. */
  lang?: string;
  /** Disable the button (e.g. while the agent is "Thinking…"). */
  disabled?: boolean;
  /** Tailwind size token — defaults to "h-9 w-9". */
  sizeClass?: string;
  /** Optional extra wrapper classes. */
  className?: string;
}

export function MicButton({
  onTranscript,
  onInterim,
  onError,
  lang,
  disabled = false,
  sizeClass = "h-9 w-9",
  className = "",
}: MicButtonProps) {
  const { supported, state, error, interim, start, stop } = useSpeechRecognition({
    lang,
    onResult: onTranscript,
  });

  // Bubble error + interim up to the parent. Effects (not direct calls in
  // the hook's render path) so we don't run parent setState during render.
  useEffect(() => {
    if (state === "error" && error && onError) onError(error);
  }, [state, error, onError]);

  useEffect(() => {
    if (onInterim) onInterim(interim);
  }, [interim, onInterim]);

  if (!supported) return null;

  const listening = state === "listening";
  const label = listening ? "Stop voice input" : "Start voice input";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={listening ? stop : start}
      disabled={disabled}
      className={`relative inline-flex items-center justify-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-40 disabled:cursor-not-allowed ${sizeClass} ${
        listening
          ? "bg-red-500/15 text-red-500 hover:bg-red-500/25 focus:ring-red-400"
          : "bg-zinc-200/70 text-zinc-700 hover:bg-zinc-300/70 dark:bg-zinc-700/60 dark:text-zinc-200 dark:hover:bg-zinc-600/70 focus:ring-zinc-400"
      } ${className}`}
    >
      {listening ? (
        <>
          <Mic className="h-4 w-4" aria-hidden />
          {/* Pulsing ring to make "listening" obvious without text */}
          <span className="absolute inset-0 rounded-full ring-2 ring-red-400/70 animate-ping pointer-events-none" />
        </>
      ) : state === "error" ? (
        <MicOff className="h-4 w-4" aria-hidden />
      ) : state === "idle" ? (
        <Mic className="h-4 w-4" aria-hidden />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      )}
    </button>
  );
}
