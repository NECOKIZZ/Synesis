/**
 * POST /api/agent/interpret
 *
 * Pass a plain-English instruction through OpenRouter (Claude) and return a
 * structured SkillResult.  This route NEVER executes anything — it only
 * interprets.  Execution happens in /api/agent/confirm-policy after the user
 * confirms with their agent PIN.
 *
 * Body: { instruction: string }
 *
 * Returns: SkillResult { skill, params, confirmation_message, requires_confirmation }
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, getAgentAllBalances } from "@/lib/agent";
import { interpretInstruction } from "@/lib/agent-core";
import type { AgentTokenBalance, AnyTaskResult } from "@/lib/agent-types";
import { resolveRecipient } from "@/lib/ans";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import crypto from "node:crypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  let instruction: string;
  try {
    const body = await req.json();
    instruction = String(body.instruction ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }

  if (instruction.length > 500) {
    return NextResponse.json({ error: "Instruction too long (max 500 chars)" }, { status: 400 });
  }

  console.log(`[agent/interpret] trace=${traceId} instruction="${instruction}" user=${supabaseUserId}`);

  const supabase = await createSupabaseServerClient();

  // ── Get agent wallet (must be activated) ─────────────────────────
  const { data: wallet } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_id")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!wallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }

  // ── Get current balance + limits for context ──────────────────────
  let agentBalanceUsdc = "0";
  let allBalances: AgentTokenBalance[] = [];
  try {
    allBalances = await getAgentAllBalances(wallet.circle_wallet_id);
    agentBalanceUsdc = allBalances.find(b => b.symbol === "USDC")?.amount ?? "0";
  } catch {
    // non-fatal — Claude will use "0" as context
  }

  const { data: limits } = await supabase
    .from("user_spend_limits")
    .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  const spendLimits = {
    max_per_transaction_usdc: Number(limits?.max_per_transaction_usdc ?? 50),
    max_daily_usdc: Number(limits?.max_daily_usdc ?? 100),
    max_weekly_usdc: Number(limits?.max_weekly_usdc ?? 300),
    max_monthly_usdc: Number(limits?.max_monthly_usdc ?? 500),
  };

  // ── Load active policies for interpreter context ───────────────────
  const { data: activePolicies } = await supabase
    .from("agent_policies")
    .select("id, policy_summary, policy_category, trigger_type, action_skill, execution_mode")
    .eq("user_id", supabaseUserId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  const formattedPolicies = (activePolicies ?? []).map((p) => ({
    id: p.id,
    summary: p.policy_summary ?? "Untitled policy",
    category: p.policy_category,
    trigger: p.trigger_type,
    action: p.action_skill,
    mode: p.execution_mode,
  }));

  // ── Call OpenRouter ───────────────────────────────────────────────
  let result: AnyTaskResult;
  try {
    result = await interpretInstruction({
      instruction,
      context: {
        limits: spendLimits,
        agentBalanceUsdc,
        activePolicies: formattedPolicies,
        allBalances,
      },
    });
    console.log(`[agent/interpret] trace=${traceId} result=${result.task_type}/${result.task_type === "immediate" ? result.skill : "multi"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent/interpret] trace=${traceId} OpenRouter error: ${msg}`);
    return NextResponse.json(
      { error: "AI interpretation failed. Check OPENROUTER_API_KEY." },
      { status: 502 }
    );
  }

  // ── Pre-resolve all recipients (before the user sees ConfirmCard) ──────
  // For compound tasks: checks ALL steps' recipients. Fail fast before PIN.
  const recipientsToCheck = extractAllRecipients(result);
  for (const recipientToCheck of recipientsToCheck) {
    try {
      await resolveRecipient(recipientToCheck);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Cannot resolve "${recipientToCheck}"`;
      console.warn(`[agent/interpret] trace=${traceId} recipient_fail="${recipientToCheck}" msg="${msg}"`);
      return NextResponse.json(
        {
          task_type: "immediate" as const,
          skill: "UNKNOWN",
          params: { explanation: `${msg}. Please check the .arc name or wallet address and try again.` },
          confirmation_message: msg,
          requires_confirmation: false,
        },
        { status: 200 },
      );
    }
  }

  console.log(`[agent/interpret] trace=${traceId} returning_ok task_type=${result.task_type}`);
  return NextResponse.json(result);
}

function extractAllRecipients(result: AnyTaskResult): string[] {
  const out: string[] = [];

  function addIfName(v: unknown) {
    const s = String(v ?? "").trim();
    if (s && !s.startsWith("0x") && !s.startsWith("$prev")) out.push(s);
  }

  function extractFromAction(action: Record<string, unknown> | undefined) {
    if (!action) return;
    const skill = String(action.skill ?? "");
    const ap = action.params as Record<string, unknown> | undefined;
    if (skill === "SEND_USDC" || skill === "SEND_TOKEN") {
      addIfName(ap?.recipient);
    }
  }

  function extractFromSteps(steps: Array<{ skill: string; params: Record<string, unknown> }> | undefined) {
    if (!steps) return;
    for (const step of steps) {
      if (step.skill === "SEND_USDC" || step.skill === "SEND_TOKEN") {
        addIfName(step.params.recipient);
      }
    }
  }

  if (result.task_type === "immediate") {
    if (result.skill === "SEND_USDC" || result.skill === "SEND_TOKEN") {
      addIfName(result.params.recipient);
    }
  } else if (result.task_type === "compound") {
    extractFromSteps(result.steps);
  } else if (result.task_type === "recurring" || result.task_type === "conditional") {
    extractFromAction(result.action);
    extractFromSteps(result.steps);
  }

  return out;
}
