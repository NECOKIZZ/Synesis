"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// jsQR ships its own TS types — no @types package needed
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsQR = require("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null;

type ScannerState = "requesting" | "active" | "denied" | "unsupported";

interface QrScannerProps {
  onScan: (value: string) => void; // called once with the decoded string
  onClose: () => void;
}

/**
 * Full-screen camera overlay that continuously decodes QR frames via jsQR.
 * Calls `onScan` the first time a QR is successfully decoded, then closes.
 *
 * Accepts:
 *   - Raw 0x wallet addresses: passed through as-is
 *   - .arc names (e.g. "alice.arc"): stripped of suffix, passed as label
 *   - pay.dotarc.app/pay/<name> or pay.dotarc.app/pay/<0x...> URLs: parsed
 *
 * Does NOT resolve names here — that happens server-side in send-prepare.
 */
export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const [state, setState] = useState<ScannerState>("requesting");

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    stop();
    onClose();
  }, [stop, onClose]);

  // Parse a raw QR string into a usable recipient value
  function extractRecipient(raw: string): string | null {
    const s = raw.trim();

    // Raw 0x address
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;

    // Plain .arc name: "alice.arc" → "alice"
    if (/^[a-z0-9-]+\.arc$/i.test(s)) return s.replace(/\.arc$/i, "");

    // dotarc.app/pay/<name-or-address>
    try {
      const url = new URL(s);
      if (url.pathname.startsWith("/pay/")) {
        const segment = url.pathname.split("/pay/")[1]?.split("/")[0];
        if (segment) return segment.replace(/\.arc$/i, "");
      }
    } catch {
      // not a URL
    }

    // ethereum: URI — extract address
    if (s.startsWith("ethereum:")) {
      const addr = s.replace(/^ethereum:/, "").split(/[@?/]/)[0];
      if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
    }

    return null;
  }

  const tick = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || firedRef.current) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);

    if (result?.data) {
      const recipient = extractRecipient(result.data);
      if (recipient) {
        firedRef.current = true;
        stop();
        onScan(recipient);
        return;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [stop, onScan]);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().then(() => {
            setState("active");
            rafRef.current = requestAnimationFrame(tick);
          });
        }
      })
      .catch(() => setState("denied"));

    return stop;
  }, [tick, stop]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black">
      {/* Camera feed */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="h-full w-full object-cover"
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Overlay UI */}
      <div className="absolute inset-0 flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-5">
          <span className="text-sm font-semibold text-white drop-shadow">Scan QR code</span>
          <button
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-xl leading-none text-white"
            aria-label="Close scanner"
          >
            ×
          </button>
        </div>

        {/* Viewfinder */}
        <div className="flex flex-1 items-center justify-center">
          <div className="relative h-64 w-64">
            {/* Corner brackets */}
            <CornerBrackets />
            {/* Scan line animation */}
            <div className="animate-scan absolute left-2 right-2 h-0.5 bg-blue-400/80" />
          </div>
        </div>

        {/* Status */}
        <div className="px-4 pb-10 text-center">
          {state === "requesting" && (
            <p className="text-sm text-white/70">Requesting camera access…</p>
          )}
          {state === "active" && (
            <p className="text-sm text-white/70">
              Point at a wallet QR code or .arc name QR
            </p>
          )}
          {state === "denied" && (
            <div className="rounded-2xl bg-black/60 p-4">
              <p className="text-sm font-semibold text-red-400">Camera access denied</p>
              <p className="mt-1 text-xs text-white/60">
                Allow camera permission in your browser settings, then try again.
              </p>
              <button
                onClick={handleClose}
                className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900"
              >
                Go back
              </button>
            </div>
          )}
          {state === "unsupported" && (
            <div className="rounded-2xl bg-black/60 p-4">
              <p className="text-sm font-semibold text-yellow-400">Camera not available</p>
              <p className="mt-1 text-xs text-white/60">
                Your browser doesn&apos;t support camera access. Paste the address manually.
              </p>
              <button
                onClick={handleClose}
                className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900"
              >
                Go back
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Corner bracket SVG decoration ────────────────────────────────────

function CornerBrackets() {
  const cls = "absolute h-8 w-8 border-white/80";
  return (
    <>
      <span className={`${cls} left-0 top-0 border-l-2 border-t-2 rounded-tl-lg`} />
      <span className={`${cls} right-0 top-0 border-r-2 border-t-2 rounded-tr-lg`} />
      <span className={`${cls} bottom-0 left-0 border-b-2 border-l-2 rounded-bl-lg`} />
      <span className={`${cls} bottom-0 right-0 border-b-2 border-r-2 rounded-br-lg`} />
    </>
  );
}
