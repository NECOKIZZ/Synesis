/**
 * useTextToSpeech
 *
 * Thin wrapper around the browser's SpeechSynthesis API.
 * Provides speak / stop / isSpeaking for agent message read-back.
 *
 * Usage:
 *   const { speak, stop, isSpeaking } = useTextToSpeech();
 *   <button onClick={() => speak(text)}>🔊</button>
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const availableRef = useRef(false);

  useEffect(() => {
    availableRef.current =
      typeof window !== "undefined" && "speechSynthesis" in window;
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!availableRef.current || !text) return;

      // Cancel any ongoing speech so we don't stack utterances.
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);

      // Pick a decent English voice if available (prefers natural-sounding
      // voices like Google US English, Samantha, etc.)
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => /Samantha|Karen|Victoria/.test(v.name)) ||
        voices.find((v) => /Google US English/.test(v.name)) ||
        voices.find((v) => v.lang.startsWith("en") && v.default) ||
        voices.find((v) => v.lang.startsWith("en"));
      if (preferred) utterance.voice = preferred;

      utterance.rate = 1.05;
      utterance.pitch = 1.0;

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);

      window.speechSynthesis.speak(utterance);
    },
    [],
  );

  return { speak, stop, isSpeaking, available: availableRef.current };
}
