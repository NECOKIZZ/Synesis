"use client";

import { useState } from "react";
import { X, Bot, Tag, Lock, Gauge, Coins, ChevronRight, Check, Loader2 } from "lucide-react";
import { useCircleWallet } from "@/app/circle-wallet-context";
import { friendlyError, friendlyApiError } from "@/lib/friendly-errors";

type Step = "name" | "pin" | "limits" | "fund" | "done";

interface Props {
  onClose: () => void;
  onActivated: () => void;
}

const PRESETS = [10, 25, 50, 100];

export default function AgentActivationModal({ onClose, onActivated }: Props) {
  const { executeChallenge } = useCircleWallet();

  const [step, setStep] = useState<Step>("name");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Step 1 — name
  const [arcNameLabel, setArcNameLabel] = useState("");
  const [skipName, setSkipName] = useState(false);

  // Step 2 — PIN
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");

  // Step 3 — limits
  const [maxPerTx, setMaxPerTx] = useState("50");
  const [maxDaily, setMaxDaily] = useState("100");
  const [maxMonthly, setMaxMonthly] = useState("500");

  // Step 4 — fund
  const [fundAmount, setFundAmount] = useState("25");

  const err = (msg: string) => { setError(msg); setLoading(false); };

  // ── Step 1: Activate wallet ────────────────────────────────────────
  async function handleName() {
    setError("");
    setLoading(true);
    const body: Record<string, string> = {};
    if (!skipName && arcNameLabel.trim()) body.arcNameLabel = arcNameLabel.trim();

    try {
      const res = await fetch("/api/agent/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return err(await friendlyApiError(res, "Couldn't activate the agent. Please try again."));
      }
      setLoading(false);
      setStep("pin");
    } catch (e) {
      return err(friendlyError(e, "Couldn't reach the server. Check your connection and try again."));
    }
  }

  // ── Step 2: Set PIN ────────────────────────────────────────────────
  async function handlePin() {
    setError("");
    if (!/^\d{4,8}$/.test(pin)) return err("PIN must be 4–8 digits.");
    if (pin !== pinConfirm) return err("Those PINs don't match. Please re-enter.");
    setLoading(true);
    try {
      const res = await fetch("/api/agent/set-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        return err(await friendlyApiError(res, "We couldn't save your PIN. Please try again."));
      }
      setLoading(false);
      setStep("limits");
    } catch (e) {
      return err(friendlyError(e, "Couldn't reach the server. Please try again."));
    }
  }

  // ── Step 3: Set limits ─────────────────────────────────────────────
  async function handleLimits() {
    setError("");
    const perTx = parseFloat(maxPerTx);
    const daily = parseFloat(maxDaily);
    const monthly = parseFloat(maxMonthly);
    if ([perTx, daily, monthly].some((v) => isNaN(v) || v <= 0)) {
      return err("All limits must be positive numbers.");
    }
    setLoading(true);
    try {
      const res = await fetch("/api/agent/set-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, maxPerTransaction: perTx, maxDaily: daily, maxMonthly: monthly }),
      });
      if (!res.ok) {
        return err(await friendlyApiError(res, "We couldn't save those limits. Please try again."));
      }
      setLoading(false);
      setStep("fund");
    } catch (e) {
      return err(friendlyError(e, "Couldn't reach the server. Please try again."));
    }
  }

  // ── Step 4: Fund agent ─────────────────────────────────────────────
  async function handleFund() {
    setError("");
    const amount = parseFloat(fundAmount);
    if (isNaN(amount) || amount <= 0) return err("Please enter a valid amount.");
    setLoading(true);

    let data: { challengeId: string; userToken: string; encryptionKey: string };
    try {
      const res = await fetch("/api/agent/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount.toFixed(6) }),
      });
      if (!res.ok) {
        return err(
          await friendlyApiError(res, "We couldn't prepare the funding transfer. Please try again."),
        );
      }
      data = await res.json();
    } catch (e) {
      return err(friendlyError(e, "Couldn't reach the server. Please try again."));
    }

    // Execute Circle PIN challenge (same as regular send)
    try {
      await executeChallenge(data.challengeId, data.userToken, data.encryptionKey);
    } catch (e) {
      return err(friendlyError(e, "PIN confirmation was cancelled. Please try again."));
    }

    setLoading(false);
    setStep("done");
  }

  function handleSkipFund() {
    setStep("done");
  }

  const stepIndex: Record<Step, number> = { name: 0, pin: 1, limits: 2, fund: 3, done: 4 };
  const steps = ["Name", "PIN", "Limits", "Fund", "Done"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-violet-400" />
            <span className="font-semibold text-white">Activate Smart Agent</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress */}
        {step !== "done" && (
          <div className="px-6 pb-4">
            <div className="flex gap-1">
              {steps.slice(0, 4).map((label, i) => (
                <div key={label} className="flex-1">
                  <div
                    className={`h-1 rounded-full transition-colors ${
                      i <= stepIndex[step] ? "bg-violet-500" : "bg-zinc-700"
                    }`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pb-6 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* ── Step: Name ─────────────────────────────────────── */}
          {step === "name" && (
            <>
              <div className="flex items-center gap-2 text-zinc-300">
                <Tag className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-medium">Give your agent a name (optional)</span>
              </div>
              <p className="text-xs text-zinc-500">
                Registers an <code className="text-violet-300">.arc</code> name for your agent wallet so others
                can send directly to it. Costs 5 USDC from your treasury balance.
              </p>
              <div className="space-y-2">
                <input
                  disabled={skipName}
                  value={arcNameLabel}
                  onChange={(e) => setArcNameLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="alice-agent"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 disabled:opacity-40"
                />
                <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={skipName}
                    onChange={(e) => setSkipName(e.target.checked)}
                    className="accent-violet-500"
                  />
                  Skip — I don&apos;t need an agent name
                </label>
              </div>
              <button
                onClick={handleName}
                disabled={loading || (!skipName && !arcNameLabel.trim())}
                className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Continue <ChevronRight className="w-4 h-4" /></>}
              </button>
            </>
          )}

          {/* ── Step: PIN ──────────────────────────────────────── */}
          {step === "pin" && (
            <>
              <div className="flex items-center gap-2 text-zinc-300">
                <Lock className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-medium">Set your agent PIN</span>
              </div>
              <p className="text-xs text-zinc-500">
                This PIN is separate from your main wallet PIN. You&apos;ll use it to confirm
                instructions before your agent acts on them.
              </p>
              <div className="space-y-2">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="4–8 digits"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 tracking-widest"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))}
                  placeholder="Confirm PIN"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 tracking-widest"
                />
              </div>
              <button
                onClick={handlePin}
                disabled={loading || pin.length < 4}
                className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Set PIN <ChevronRight className="w-4 h-4" /></>}
              </button>
            </>
          )}

          {/* ── Step: Limits ───────────────────────────────────── */}
          {step === "limits" && (
            <>
              <div className="flex items-center gap-2 text-zinc-300">
                <Gauge className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-medium">Set spending guardrails</span>
              </div>
              <p className="text-xs text-zinc-500">
                Your agent can never exceed these limits — even if you instruct it to.
                You can change them later with your PIN.
              </p>
              <div className="space-y-3">
                {[
                  { label: "Max per transaction (USDC)", value: maxPerTx, set: setMaxPerTx },
                  { label: "Max per day (USDC)", value: maxDaily, set: setMaxDaily },
                  { label: "Max per month (USDC)", value: maxMonthly, set: setMaxMonthly },
                ].map(({ label, value, set }) => (
                  <div key={label}>
                    <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
                    <input
                      type="number"
                      min="1"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={handleLimits}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Save Limits <ChevronRight className="w-4 h-4" /></>}
              </button>
            </>
          )}

          {/* ── Step: Fund ─────────────────────────────────────── */}
          {step === "fund" && (
            <>
              <div className="flex items-center gap-2 text-zinc-300">
                <Coins className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-medium">Fund your agent</span>
              </div>
              <p className="text-xs text-zinc-500">
                Transfer USDC from your main wallet to the agent. Your main wallet PIN will be
                required. You can top up anytime from the agent page.
              </p>
              <div className="flex gap-2 flex-wrap">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setFundAmount(String(p))}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      fundAmount === String(p)
                        ? "bg-violet-600 border-violet-500 text-white"
                        : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-violet-600"
                    }`}
                  >
                    ${p}
                  </button>
                ))}
              </div>
              <input
                type="number"
                min="1"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSkipFund}
                  className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 hover:text-white text-sm transition-colors"
                >
                  Skip for now
                </button>
                <button
                  onClick={handleFund}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Fund Agent"}
                </button>
              </div>
            </>
          )}

          {/* ── Step: Done ─────────────────────────────────────── */}
          {step === "done" && (
            <div className="text-center py-4 space-y-4">
              <div className="w-14 h-14 rounded-full bg-violet-600/20 border border-violet-500 flex items-center justify-center mx-auto">
                <Check className="w-7 h-7 text-violet-400" />
              </div>
              <div>
                <p className="text-white font-semibold text-lg">Agent is ready</p>
                <p className="text-zinc-400 text-sm mt-1">
                  Chat with your agent to send USDC, set up recurring payments, and more.
                </p>
              </div>
              <button
                onClick={onActivated}
                className="w-full bg-violet-600 hover:bg-violet-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
              >
                Open Agent Chat
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
