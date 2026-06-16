"use client";

/**
 * Root-level error boundary for the Next.js App Router.
 *
 * This catches errors that escape every other boundary — including ones
 * thrown by the root layout itself. Because it replaces the root layout
 * when active, it must render its own <html> and <body>.
 *
 * For per-route errors (most rendering crashes) see `app/error.tsx`.
 */

import { useEffect } from "react";
import { friendlyError } from "@/lib/friendly-errors";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface in the dev console + any future error-reporting hook.
    console.error("[global-error]", error);
  }, [error]);

  const message = friendlyError(error, "Something broke unexpectedly. Please reload.");

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#06122c",
          color: "#fff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: "1.5rem",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: "1.75rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 1rem",
              fontSize: 28,
            }}
            aria-hidden
          >
            !
          </div>

          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 0.5rem" }}>
            Something went wrong
          </h1>

          <p
            style={{
              fontSize: 14,
              color: "rgba(255,255,255,0.7)",
              margin: "0 0 1.25rem",
              lineHeight: 1.5,
            }}
          >
            {message}
          </p>

          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => reset()}
              style={{
                padding: "0.55rem 1rem",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "transparent",
                color: "#fff",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={() => {
                if (typeof window !== "undefined") window.location.assign("/wallet");
              }}
              style={{
                padding: "0.55rem 1rem",
                borderRadius: 10,
                border: "none",
                background: "#3b82f6",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload app
            </button>
          </div>

          {error.digest && (
            <p
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.35)",
                marginTop: "1rem",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
