/**
 * lib/skills/pin-policy.ts
 *
 * Single source of truth for "does this batch of tasks need a PIN?".
 *
 * Shared by:
 *   - app/api/agent/interpret/route.ts   — to tell the UI whether to
 *                                          show the PIN input
 *   - app/api/agent/confirm-policy/route.ts — to gate the actual
 *                                             verifyAgentPinOrThrow call
 *
 * Keeping the rule in ONE place prevents drift between "what the UI
 * thinks needs a PIN" and "what the server actually checks".
 *
 * Decision rule (matches user-stated policy "outward only"):
 *   - SkillHandler.requiresPin === false       → no PIN
 *   - SkillHandler.requiresPin === true        → PIN
 *   - SkillHandler.requiresPin === undefined   → PIN  (fail-safe)
 *   - SkillHandler.requiresPin (function)      → invoked with params +
 *                                                 mainWalletAddress
 *   - any throw inside the function form       → PIN  (fail-safe)
 */

import "server-only";
import { skillRegistry } from "./index";
import type { Task } from "@/lib/agent-types";

export function batchRequiresPin(tasks: Task[], mainWalletAddress: string): boolean {
  for (const task of tasks) {
    for (const step of task.steps) {
      const handler = skillRegistry[step.skill];
      if (!handler) return true; // unknown skill → fail-safe
      const r = handler.requiresPin;
      if (r === false) continue;
      if (r === undefined || r === true) return true;
      if (typeof r === "function") {
        try {
          if (r(step.params, { mainWalletAddress })) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}
