"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCircleWallet } from "../circle-wallet-context";
import { QrScanner } from "./qr-scanner";
import { ArcLoader } from "@/app/components/arc-loader";
import { friendlyError, friendlyApiError } from "@/lib/friendly-errors";

const ARC_EXPLORER =
  process.env.NEXT_PUBLIC_ARC_EXPLORER_URL || "https://testnet.arcscan.app/tx/";

// ── Types ────────────────────────────────────────────────────────────

type Step = "input" | "preparing" | "confirm" | "signing" | "done" | "failed";

type ResolvePreview =
  | { ok: true; address: string; arcName: string | null }
  | { ok: false; reason: string }
  | null;

type PrepareResponse = {
  challengeId: string;
  userToken: string;
  encryptionKey: string;
  resolvedAddress: string;
  resolvedName: string | null;
  amount: string;
  // Issue #17: id of the PENDING wallet_transactions row inserted by
  // send-prepare. Used to poll for the tx_hash that Circle's webhook
  // writes back ~2-3s after the SDK reports COMPLETE. May be null if the
  // best-effort activity log insert failed server-side.
  pendingRowId?: string | null;
};

// ── Helpers ──────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatUsdc(val: string) {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

// Ask the webhook-populated wallet_transactions row whether a send actually
// settled, independent of what Circle's flaky SDK callback reported. Returns
// confirmed=true as soon as status===COMPLETE or a tx hash exists. Bounded
// (default ~6s) so a webhook outage can never hang the modal — worst case we
// fall back to the honest "uncertain, check activity" screen.
async function confirmSendViaWebhook(
  rowId: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ confirmed: boolean; txHash: string | null }> {
  const attempts = opts.attempts ?? 8;
  const intervalMs = opts.intervalMs ?? 800;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        `/api/wallet/tx-hash?id=${encodeURIComponent(rowId)}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = (await res.json()) as { txHash: string | null; status?: string };
        if (data.status === "COMPLETE" || data.txHash) {
          return { confirmed: true, txHash: data.txHash ?? null };
        }
        if (data.status === "FAILED") return { confirmed: false, txHash: null };
      }
    } catch {
      // transient — keep trying
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { confirmed: false, txHash: null };
}

// ── Component ────────────────────────────────────────────────────────

interface SendModalProps {
  onClose: () => void;
  onSent: () => void; // called after success so the parent can refresh balance
}

export function SendModal({ onClose, onSent }: SendModalProps) {
  const { executeChallenge } = useCircleWallet();

  // ── Form state
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Recipient resolution preview (display-only)
  const [preview, setPreview] = useState<ResolvePreview>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── What the SERVER resolved (used in confirm + signing)
  const [prepared, setPrepared] = useState<PrepareResponse | null>(null);

  // ── Tx hash captured from Circle SDK on success (null until done).
  //    On Arc Testnet the SDK frequently returns null — see the polling
  //    effect below which fills this in from the webhook-populated row.
  const [txHash, setTxHash] = useState<string | null>(null);
  // True while we're polling /api/wallet/tx-hash for the webhook to
  // surface the hash. Drives the "Confirming…" placeholder copy on the
  // Done screen so the user knows we're still working.
  const [hashPolling, setHashPolling] = useState(false);

  // ── Signing-step status escalation. After ~4s of waiting we swap the
  //    label to a friendlier "still loading" message so the user knows
  //    the lag is on Circle's end, not a bug.
  const [signingStalled, setSigningStalled] = useState(false);

  // ── QR scanner
  const [showScanner, setShowScanner] = useState(false);

  // ── Resolve preview with debounce (display-only — server re-resolves at submit)
  useEffect(() => {
    const q = recipient.trim();
    if (!q) { setPreview(null); return; }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/circle/resolve-recipient?q=${encodeURIComponent(q)}`,
          { credentials: "include" }
        );
        const data = await res.json();
        setPreview(data);
      } catch {
        setPreview(null);
      }
    }, 450);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [recipient]);

  // ── Step 1 → 2: call send-prepare
  const handleReview = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStep("preparing");

    try {
      const res = await fetch("/api/circle/send-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ recipient: recipient.trim(), amount: amount.trim() }),
      });
      if (!res.ok) {
        setErrorMsg(await friendlyApiError(res, "Couldn't prepare the transfer. Try again."));
        setStep("input");
        return;
      }
      const data = await res.json();
      setPrepared(data as PrepareResponse);
      setStep("confirm");
    } catch (err) {
      setErrorMsg(friendlyError(err, "Couldn't reach the server. Check your connection and try again."));
      setStep("input");
    }
  }, [recipient, amount]);

  // ── Step 3 → 4: execute challenge (PIN dialog)
  const handleConfirm = useCallback(async () => {
    if (!prepared) return;
    setErrorMsg(null);
    setSigningStalled(false);
    setStep("signing");

    try {
      const result = await executeChallenge(
        prepared.challengeId,
        prepared.userToken,
        prepared.encryptionKey
      );
      // Paint the success UI BEFORE telling the parent to refresh.
      // Otherwise the parent's re-render can race with our state update
      // and unmount us before "done" is visible.
      setTxHash(result.txHash);
      setStep("done");
      onSent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // A genuine, user-initiated cancel rejects WITHOUT broadcasting (the SDK
      // only hits our error branch when the challenge never COMPLETEs), so
      // there's nothing for the webhook to confirm. Check this FIRST and
      // short-circuit — no 6s poll on a deliberate cancel. Keep it soft: drop
      // back to the confirm screen with a gentle note, not a red "failed".
      const isCancel =
        /cancel|aborted|rejected by user|user.*denied/i.test(msg) &&
        !/activity feed|went through|processing|response from the wallet/i.test(msg);
      if (isCancel) {
        setErrorMsg("You cancelled the PIN dialog — nothing was sent. Review and try again.");
        setStep("confirm");
        return;
      }

      // Not a clean cancel. Circle's W3S SDK callback is unreliable on Arc
      // Testnet: a spurious "Network error" (its hardcoded 10s iframe timeout),
      // a stale iframe, or our own long safety guard can reject even when the
      // transfer actually broadcast. The webhook is the source of truth — so
      // before showing failure we ask it whether the send settled. If it did,
      // this was a false alarm: show success.
      if (prepared.pendingRowId) {
        const verdict = await confirmSendViaWebhook(prepared.pendingRowId);
        if (verdict.confirmed) {
          setTxHash(verdict.txHash);
          setStep("done");
          onSent();
          return;
        }
      }

      // Anything ambiguous (timeout, network, SDK "Network error", stale
      // iframe, unexpected status, our 5-min guard) → honest "uncertain"
      // state. The webhook hasn't confirmed within our short window, but the
      // tx may still land, so we tell the user to check activity rather than
      // implying a clean failure. (The "activity feed" wording flips the
      // failed screen to its amber "Status uncertain" variant.)
      const isUncertain =
        /timeout|timed out|reset|connect|network|fetch|econnreset|w3s|iframe|unexpected status|activity feed|went through|processing|response from the wallet/i.test(
          msg,
        );
      if (isUncertain) {
        setErrorMsg(
          "We couldn't confirm the transfer before the dialog closed. It may still have gone through — check your activity feed before retrying."
        );
        setStep("failed");
        onSent(); // refresh balance/activity so the user can verify
        return;
      }

      setErrorMsg(friendlyError(err, "Transaction couldn't be completed."));
      setStep("failed");
    }
  }, [prepared, executeChallenge, onSent]);

  // While we're in the signing step, escalate the loading copy if Circle
  // takes more than ~4s to surface its PIN dialog.
  useEffect(() => {
    if (step !== "signing") {
      setSigningStalled(false);
      return;
    }
    const t = setTimeout(() => setSigningStalled(true), 4000);
    return () => clearTimeout(t);
  }, [step]);

  // ── Issue #17: poll for the tx hash from the webhook ___________________
  //
  // Circle's W3S browser SDK does not consistently return `txHash` in
  // `onComplete` on Arc Testnet — the value arrives 2-3 seconds later via
  // the webhook, which writes it to the wallet_transactions row. Without
  // this poll the "View transaction" button on the Done screen never
  // renders even though we know the hash exists.
  //
  // We only poll when we entered Done WITHOUT a hash AND have a row id
  // to look up. Capped at ~12s (15 attempts × 800ms) so a webhook outage
  // can't keep the modal busy forever — worst case the user falls back
  // to the Activity tab to find the hash.
  useEffect(() => {
    if (step !== "done") return;
    if (txHash) return;
    if (!prepared?.pendingRowId) return;

    const id = prepared.pendingRowId;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 15;
    const INTERVAL_MS = 800;

    setHashPolling(true);

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch(
          `/api/wallet/tx-hash?id=${encodeURIComponent(id)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = (await res.json()) as { txHash: string | null };
          if (!cancelled && data.txHash) {
            setTxHash(data.txHash);
            setHashPolling(false);
            return;
          }
        }
      } catch {
        // Swallow — transient network errors should not abort the poll.
      }
      if (cancelled) return;
      if (attempts >= MAX_ATTEMPTS) {
        setHashPolling(false);
        return;
      }
      timer = setTimeout(poll, INTERVAL_MS);
    };

    let timer: ReturnType<typeof setTimeout> = setTimeout(poll, INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setHashPolling(false);
    };
  }, [step, txHash, prepared?.pendingRowId]);

  const handleClose = useCallback(() => {
    // Don't allow dismissal while PIN dialog or prepare is in flight
    if (step === "preparing" || step === "signing") return;
    onClose();
  }, [step, onClose]);

  // ── Backdrop click closes (unless busy)
  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  }, [handleClose]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div
      onClick={handleBackdrop}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 shadow-2xl"
        style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}
      >
        {/* ── Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h3 className="text-base font-semibold text-white">
            {step === "confirm" ? "Confirm send" : step === "done" ? "Done" : "Send USDC"}
          </h3>
          {step !== "preparing" && step !== "signing" && (
            <button
              onClick={handleClose}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white"
              aria-label="Close"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="p-5">
          {/* ════════════════════════════════════════ INPUT STEP */}
          {(step === "input" || step === "preparing") && (
            <form onSubmit={handleReview} className="space-y-4">
              {errorMsg && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                  {errorMsg}
                </div>
              )}

              {/* Recipient */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-white/50">
                  To
                </label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    autoFocus
                    placeholder="alice.arc or 0x…"
                    value={recipient}
                    onChange={(e) => { setRecipient(e.target.value); setErrorMsg(null); }}
                    disabled={step === "preparing"}
                    className="w-full rounded-xl border border-white/15 bg-[#0a1630] py-2.5 pl-3 pr-10 text-sm text-white outline-none placeholder:text-white/25 focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 disabled:opacity-50"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {/* QR scan button */}
                  <button
                    type="button"
                    onClick={() => setShowScanner(true)}
                    disabled={step === "preparing"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-white/40 transition hover:text-white/80 disabled:opacity-40"
                    aria-label="Scan QR code"
                    title="Scan QR code"
                  >
                    <QrIcon />
                  </button>
                </div>
                {/* Resolution preview */}
                {recipient.trim() && preview !== null && (
                  <div className={`mt-1.5 text-xs ${preview.ok ? "text-emerald-400" : "text-red-400"}`}>
                    {preview.ok
                      ? preview.arcName
                        ? `✓ ${preview.arcName} → ${shortAddr(preview.address)}`
                        : `✓ ${shortAddr(preview.address)}`
                      : `✗ ${preview.reason}`}
                  </div>
                )}
              </div>

              {/* Amount */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-white/50">
                  Amount (USDC)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, "");
                      const parts = v.split(".");
                      if (parts.length > 2) return;
                      if (parts[1] && parts[1].length > 6) return;
                      setAmount(v);
                    }}
                    disabled={step === "preparing"}
                    className="w-full rounded-xl border border-white/15 bg-[#0a1630] py-2.5 pl-3 pr-16 text-sm text-white outline-none placeholder:text-white/25 focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 disabled:opacity-50"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-white/40">
                    USDC
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/30">Max 6 decimal places</p>
              </div>

              <button
                type="submit"
                disabled={
                  step === "preparing" ||
                  !recipient.trim() ||
                  !amount.trim() ||
                  parseFloat(amount) <= 0
                }
                className="mt-1 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 active:scale-[0.98] disabled:opacity-40"
              >
                {step === "preparing" ? (
                  <ArcLoader size="inline" label="Checking…" />
                ) : (
                  "Review"
                )}
              </button>
            </form>
          )}

          {/* ════════════════════════════════════════ CONFIRM STEP */}
          {step === "confirm" && prepared && (
            <div className="space-y-4">
              {errorMsg && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
                  {errorMsg}
                </div>
              )}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="space-y-3">
                  <Row
                    label="To"
                    value={
                      prepared.resolvedName
                        ? (
                          <span>
                            <span className="font-semibold text-blue-400">
                              {prepared.resolvedName.split(".")[0]}
                            </span>
                            <span className="text-white/50">.arc</span>
                            <span className="ml-2 font-mono text-xs text-white/40">
                              {shortAddr(prepared.resolvedAddress)}
                            </span>
                          </span>
                        )
                        : (
                          <span className="break-all font-mono text-xs text-white/80">
                            {prepared.resolvedAddress}
                          </span>
                        )
                    }
                  />
                  <Row
                    label="Amount"
                    value={
                      <span className="font-semibold text-white">
                        {formatUsdc(prepared.amount)}{" "}
                        <span className="font-normal text-white/50">USDC</span>
                      </span>
                    }
                  />
                  <Row label="Network" value="Arc Testnet" />
                  <Row label="Token" value="USDC" />
                </div>
              </div>

              <p className="text-xs text-white/40">
                You&apos;ll confirm with your PIN next. These are the exact values that will be signed — double-check the recipient before continuing.
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => { setErrorMsg(null); setPrepared(null); setStep("input"); }}
                  className="flex-1 rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  Back
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 active:scale-[0.98]"
                >
                  Confirm & send
                </button>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════ SIGNING STEP */}
          {/* Keep the prepared transaction summary visible behind the loader
              so the user always knows what they're confirming, even if
              Circle's PIN dialog hasn't surfaced yet. The escalating label
              after ~4s explains lag without alarming. */}
          {step === "signing" && (
            <div className="space-y-4">
              {prepared && (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="space-y-3">
                    <Row
                      label="To"
                      value={
                        prepared.resolvedName ? (
                          <span>
                            <span className="font-semibold text-blue-400">
                              {prepared.resolvedName.split(".")[0]}
                            </span>
                            <span className="text-white/50">.arc</span>
                          </span>
                        ) : (
                          <span className="break-all font-mono text-xs text-white/80">
                            {shortAddr(prepared.resolvedAddress)}
                          </span>
                        )
                      }
                    />
                    <Row
                      label="Amount"
                      value={
                        <span className="font-semibold text-white">
                          {formatUsdc(prepared.amount)}{" "}
                          <span className="font-normal text-white/50">USDC</span>
                        </span>
                      }
                    />
                  </div>
                </div>
              )}
              <ArcLoader
                size="card"
                label={
                  signingStalled
                    ? "Still loading — give it a moment"
                    : "Opening secure PIN entry…"
                }
                showFacts={false}
              />
            </div>
          )}

          {/* ════════════════════════════════════════ DONE STEP */}
          {step === "done" && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30">
                <svg className="h-7 w-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="font-semibold text-white">Transaction done</p>
              {prepared && (
                <p className="mt-1 text-sm text-white/50">
                  {formatUsdc(prepared.amount)} USDC →{" "}
                  {prepared.resolvedName ?? shortAddr(prepared.resolvedAddress)}
                </p>
              )}
              <p className="mt-2 text-xs text-white/30">
                Settled on Arc Testnet. Your balance will refresh in a moment.
              </p>
              <div className="mt-5 flex gap-2">
                {/* Tx hash button. Renders the explorer link as soon as we
                    have the hash — either from the SDK (rare on Arc Testnet)
                    or from polling the webhook-populated row (see effect
                    above). While polling we show a disabled placeholder so
                    the slot doesn't snap-in when the hash arrives. */}
                {txHash ? (
                  <a
                    href={`${ARC_EXPLORER}${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                  >
                    <span className="font-mono text-xs">{shortAddr(txHash)}</span>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                ) : hashPolling ? (
                  <button
                    type="button"
                    disabled
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white/50"
                    title="Waiting for confirmation on chain…"
                  >
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-transparent" aria-hidden />
                    <span>Confirming…</span>
                  </button>
                ) : null}
                <button
                  onClick={onClose}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════ FAILED STEP */}
          {step === "failed" && (() => {
            const isUncertain = /activity feed|went through/i.test(errorMsg ?? "");
            return (
              <div className="py-6 text-center">
                <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${isUncertain ? "bg-amber-500/15 ring-1 ring-amber-500/30" : "bg-red-500/15 ring-1 ring-red-500/30"}`}>
                  {isUncertain ? (
                    <svg className="h-7 w-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                  ) : (
                    <svg className="h-7 w-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </div>
                <p className="font-semibold text-white">{isUncertain ? "Status uncertain" : "Transaction failed"}</p>
                {errorMsg && (
                  <p className={`mt-1 text-sm ${isUncertain ? "text-amber-400" : "text-red-400"}`}>{errorMsg}</p>
                )}
                <div className="mt-5 flex gap-2">
                  <button
                    onClick={onClose}
                    className="flex-1 rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
                  >
                    {isUncertain ? "Close & check" : "Cancel"}
                  </button>
                  {!isUncertain && (
                    <button
                      onClick={() => { setErrorMsg(null); setPrepared(null); setStep("input"); }}
                      className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
                    >
                      Try again
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* QR scanner overlay */}
      {showScanner && (
        <QrScanner
          onScan={(value) => {
            setRecipient(value);
            setErrorMsg(null);
            setShowScanner(false);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

// ── Small layout helpers ──────────────────────────────────────────────────

function QrIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path strokeLinecap="round" d="M14 14h2m3 0h1M14 17v1m0 3h1M17 14v3m0 4h3M20 17v4" />
    </svg>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-sm">
      <span className="shrink-0 text-white/50">{label}</span>
      <span className="text-right text-white/80">{value}</span>
    </div>
  );
}
