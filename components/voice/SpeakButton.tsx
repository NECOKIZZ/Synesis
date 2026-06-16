"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useTextToSpeech } from "@/lib/voice/use-text-to-speech";

/**
 * SpeakButton
 *
 * A small speaker icon that reads the provided text aloud using the
 * browser's built-in text-to-speech engine. Click again to stop.
 */
export function SpeakButton({
  text,
  sizeClass = "h-6 w-6",
  iconClass = "h-3.5 w-3.5",
  className,
}: {
  text: string;
  sizeClass?: string;
  iconClass?: string;
  className?: string;
}) {
  const { speak, stop, isSpeaking, available } = useTextToSpeech();
  if (!available) return null;

  return (
    <button
      type="button"
      onClick={() => (isSpeaking ? stop() : speak(text))}
      aria-label={isSpeaking ? "Stop speaking" : "Read aloud"}
      className={`inline-flex items-center justify-center rounded-full transition ${sizeClass} ${
        isSpeaking
          ? "bg-amber-100 text-amber-600"
          : className ?? "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
      }`}
    >
      {isSpeaking ? (
        <VolumeX className={iconClass} />
      ) : (
        <Volume2 className={iconClass} />
      )}
    </button>
  );
}
