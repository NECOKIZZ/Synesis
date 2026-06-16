"use client";

/**
 * Route-level error boundary.
 *
 * Catches errors thrown during rendering, in lifecycle methods, and in
 * constructors of the whole route tree. Unlike `global-error.tsx`, this
 * still has the root layout around it, so we can use Tailwind + the
 * usual font / wallet context wrappers.
 *
 * Use this for "unexpected" crashes — anything we didn't anticipate.
 * Predictable failures (network, validation, etc.) should be handled
 * inline by the calling component with friendlyError().
 */

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import { friendlyError } from "@/lib/friendly-errors";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route-error]", error);
  }, [error]);

  const message = friendlyError(error, "We hit an unexpected error on this page.");

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#06122c] px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
          <AlertTriangle className="h-7 w-7 text-red-400" aria-hidden />
        </div>

        <h1 className="mb-2 text-lg font-semibold text-white">
          Something went wrong
        </h1>

        <p className="mb-5 text-sm leading-relaxed text-white/70">{message}</p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            onClick={() => reset()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-transparent px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/5"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          <Link
            href="/wallet"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <Home className="h-4 w-4" />
            Go to wallet
          </Link>
        </div>

        {error.digest && (
          <p className="mt-4 font-mono text-[11px] text-white/35">
            Ref: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
