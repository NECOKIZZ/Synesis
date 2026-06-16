/**
 * Layer A — in-session conversation history (client-side).
 *
 * Both agent chat surfaces (the embedded AgentTab in wallet-shell and the
 * standalone /agent page) hold their turns in React state. This helper
 * turns that UI state into the trimmed, role-mapped array the interpret
 * API forwards to the model — so follow-ups like "make it 20" resolve
 * against the previous turn.
 *
 * Client-safe: no "server-only", no Node imports. Pure function.
 *
 * What we DON'T send:
 *   - the welcome message, system notices, and pending "Thinking…" stubs
 *   - raw task JSON (we send the human-readable text only, so the parser
 *     isn't confused by seeing its own output shape echoed back)
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Minimal shape both surfaces satisfy. */
type UIMessage = { role: string; text: string; pending?: boolean; id?: string };

export const HISTORY_MAX_TURNS = 12;
const TURN_MAX_CHARS = 1000;

export function buildConversationHistory(
  messages: UIMessage[],
  maxTurns: number = HISTORY_MAX_TURNS,
): ChatTurn[] {
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "agent") &&
        !m.pending &&
        m.id !== "welcome" &&
        typeof m.text === "string" &&
        m.text.trim().length > 0 &&
        m.text !== "Thinking…",
    )
    .map<ChatTurn>((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text.slice(0, TURN_MAX_CHARS),
    }))
    .slice(-maxTurns);
}
