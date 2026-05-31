/**
 * Agent Trace CLI
 *
 * Usage:
 *   npx tsx scripts/agent-trace.ts "send 5 USDC to alice" \
 *     '{"limits":{"max_per_transaction_usdc":100,"max_daily_usdc":500,"max_weekly_usdc":2000,"max_monthly_usdc":5000},"agentBalanceUsdc":"50.00","activePolicies":[]}'
 *
 * Or with a JSON file:
 *   npx tsx scripts/agent-trace.ts --file test-cases/send-usdc.json
 */

import {
  buildSystemPrompt,
  validateTaskResult,
} from "../lib/agent-core";
import type { AnyTaskResult } from "../lib/agent-types";

const args = process.argv.slice(2);

function usage() {
  console.error(`
Usage:
  npx tsx scripts/agent-trace.ts "<instruction>" '<json-context>'
  npx tsx scripts/agent-trace.ts --file <path-to-json>

JSON context shape:
  {
    limits: { max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc },
    agentBalanceUsdc: string,
    activePolicies: Array,
    allBalances?: Array<{ symbol, amount, approxUsdValue }>,
    livePrices?: { eurcUsdc, cirBtcUsdc }
  }
`);
  process.exit(1);
}

interface TraceInput {
  instruction: string;
  context: Parameters<typeof buildSystemPrompt>[0];
  apiKey?: string;
  model?: string;
  referer?: string;
}

async function main() {
  let input: TraceInput;

  if (args.length === 0) usage();

  if (args[0] === "--file") {
    if (!args[1]) usage();
    const fs = await import("node:fs");
    const raw = fs.readFileSync(args[1], "utf-8");
    input = JSON.parse(raw) as TraceInput;
  } else {
    const instruction = args[0];
    const contextRaw = args[1] ?? "{}";
    let context: TraceInput["context"];
    try {
      context = JSON.parse(contextRaw);
    } catch {
      console.error("Failed to parse context JSON:", contextRaw);
      process.exit(1);
    }
    input = { instruction, context };
  }

  const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = input.model ?? process.env.OPENROUTER_MODEL;
  const referer = input.referer ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://wallet.dotarc.my";

  if (!apiKey) {
    console.error("No OPENROUTER_API_KEY found. Provide it via env var or input.apiKey.");
    process.exit(1);
  }

  // ── Build system prompt ──────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(input.context);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  SYSTEM PROMPT");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(systemPrompt);
  console.log();

  // ── User instruction ─────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  USER INSTRUCTION");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(input.instruction);
  console.log();

  // ── Single LLM call ──────────────────────────────────────────────────
  const t0 = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "DotArc Smart Wallet (Trace)",
    },
    body: JSON.stringify({
      model: model ?? "anthropic/claude-3.5-sonnet",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.instruction },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1024,
      temperature: 0.1,
    }),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("OpenRouter HTTP error:", res.status, errText.slice(0, 500));
    process.exit(1);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const latencyMs = Date.now() - t0;

  // ── Raw response ─────────────────────────────────────────────────────
  console.log("───────────────────────────────────────────────────────────────────");
  console.log("  RAW LLM RESPONSE");
  console.log("───────────────────────────────────────────────────────────────────");
  console.log(content);
  console.log();

  // ── Parsed JSON ──────────────────────────────────────────────────────
  console.log("───────────────────────────────────────────────────────────────────");
  console.log("  PARSED JSON");
  console.log("───────────────────────────────────────────────────────────────────");
  const rawStripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStripped);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log("[JSON parse failed — see raw response above]");
  }
  console.log();

  // ── Validation ───────────────────────────────────────────────────────
  console.log("───────────────────────────────────────────────────────────────────");
  console.log("  VALIDATION");
  console.log("───────────────────────────────────────────────────────────────────");
  let validated: AnyTaskResult | null = null;
  let validationError: string | null = null;
  try {
    validated = validateTaskResult(parsed);
    console.log("VALID ✓");
    console.log(JSON.stringify(validated, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    validationError = msg;
    console.log("INVALID ✗");
    console.log(msg);
  }
  console.log();

  // ── What interpretInstruction would return ───────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  FINAL RESULT (what interpretInstruction would return)");
  console.log("═══════════════════════════════════════════════════════════════════");
  let finalResult: AnyTaskResult;
  if (validated) {
    finalResult = validated;
  } else {
    finalResult = {
      task_type: "immediate" as const,
      skill: "UNKNOWN" as const,
      params: { explanation: "I couldn't understand that instruction — please rephrase it." },
      confirmation_message: "Could not parse instruction",
      requires_confirmation: false,
    };
  }
  console.log(JSON.stringify(finalResult, null, 2));
  console.log();
  console.log("Latency:", latencyMs, "ms");

  // Return non-zero on validation failure so CI can catch it
  if (validationError) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
