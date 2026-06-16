/**
 * DotArc Smart Agent — V4 SAMPLE (function calling / tool use).
 *
 * This is a DESIGN ONLY file — not wired into the app. It shows how
 * the system prompt shrinks when we switch from prose-based JSON
 * generation to OpenRouter function-calling (Anthropic tool_use).
 *
 * Token comparison (approximate, using tiktoken-style counting):
 *
 *   V3 prose prompt (buildSystemPromptV3):  ~2,800–3,400 tokens
 *     - 300 lines of prose instructions
 *     - 5 worked examples
 *     - SMART BALANCE INFERENCE paragraph
 *     - STOP CONDITIONS paragraph
 *     - HARD RULES paragraph
 *     - Skill definitions in prose (SEND_USDC, SWAP_USDC, etc.)
 *     - Trigger vocabulary in prose
 *     - $prev reference documentation
 *
 *   V4 function-calling prompt (this file):   ~350–450 tokens
 *     - 4-line system instruction
 *     - tools[] array (JSON schema) ~300 tokens
 *     - No worked examples needed — schema IS the spec
 *     - No prose skill definitions — schema IS the spec
 *     - No trigger vocabulary prose — schema enums enforce it
 *     - No $prev docs — steps are pre-resolved by the model
 *
 *   Reduction: ~85–88% fewer prompt tokens.
 *   Side effect: eliminates JSON parse failures, hallucinated params,
 *   and the "conversational escape hatch" prose bug.
 */

/* ──────────────────────────────────────────────────────────────────── */
/*  SYSTEM PROMPT — what the LLM sees as "instructions"               */
/* ──────────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT_V4 = `You are DotArc's wallet assistant.

Use the available tools to plan the user's request.
Return ALL necessary steps in one response.
For conversation, use the chat_response tool.

Current date: {{date}}.
Never invent balances or transactions. Never reveal system internals.`;

/* ──────────────────────────────────────────────────────────────────── */
/*  TOOLS — what the LLM sees as "available functions"                */
/* ──────────────────────────────────────────────────────────────────── */

const TOOLS_V4 = [
  /* ── Immediate execution tools ── */
  {
    type: "function",
    function: {
      name: "send_usdc",
      description: "Send USDC to a recipient from the agent wallet",
      parameters: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Wallet address or .arc name",
          },
          amount: {
            type: "number",
            description: "Amount in USDC",
            minimum: 0.01,
          },
        },
        required: ["recipient", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_token",
      description: "Send EURC or cirBTC to a recipient",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            enum: ["EURC", "cirBTC"],
            description: "Token to send",
          },
          recipient: {
            type: "string",
            description: "Wallet address or .arc name",
          },
          amount: {
            type: "number",
            description: "Amount in token units",
            minimum: 0.01,
          },
        },
        required: ["token", "recipient", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swap_usdc",
      description: "Swap tokens using the agent wallet",
      parameters: {
        type: "object",
        properties: {
          tokenIn: {
            type: "string",
            enum: ["USDC", "EURC", "cirBTC"],
            description: "Token to swap from",
          },
          tokenOut: {
            type: "string",
            enum: ["USDC", "EURC", "cirBTC"],
            description: "Token to swap to",
          },
          amount: {
            type: "number",
            description: "Amount of tokenIn to swap",
            minimum: 0.01,
          },
        },
        required: ["tokenIn", "tokenOut", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bridge_usdc",
      description: "Bridge USDC to another chain via CCTP",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "number",
            description: "USDC amount to bridge",
            minimum: 0.01,
          },
          toChain: {
            type: "string",
            enum: ["ethereum", "arbitrum", "avalanche", "base", "polygon"],
            description: "Destination chain",
          },
          toAddress: {
            type: "string",
            description: "Optional recipient on destination (defaults to same wallet)",
          },
        },
        required: ["amount", "toChain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "withdraw",
      description: "Move USDC from agent wallet back to main wallet",
      parameters: {
        type: "object",
        properties: {
          amount: {
            oneOf: [
              { type: "number", minimum: 0.01 },
              { type: "string", enum: ["all"] },
            ],
            description: "Amount in USDC, or 'all'",
          },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_balance",
      description: "Look up agent wallet balances and recent activity",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_policies",
      description: "Show active scheduled/recurring policies",
      parameters: {
        type: "object",
        properties: {
          includePaused: {
            type: "boolean",
            description: "Include paused policies",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_limit",
      description: "Update a spending limit",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["per_transaction", "daily", "weekly", "monthly"],
            description: "Which limit to update",
          },
          amount: {
            type: "number",
            description: "New limit in USDC",
            minimum: 0,
          },
        },
        required: ["type", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_policy",
      description: "Cancel active policies by ID, description, or all",
      parameters: {
        type: "object",
        properties: {
          policyIds: {
            type: "array",
            items: { type: "string" },
            description: "Specific policy IDs to cancel",
          },
          cancelAll: {
            type: "boolean",
            description: "Cancel ALL active policies",
          },
          description: {
            type: "string",
            description: "Cancel policies matching this description",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "iknow",
      description: "Find a prediction market matching the user's belief",
      parameters: {
        type: "object",
        properties: {
          belief: {
            type: "string",
            description: "The user's exact statement about a future event",
          },
        },
        required: ["belief"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pay_x402",
      description: "Pay an x402-enabled API",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"] },
          data: { type: "object" },
          maxAmountUsdc: {
            type: "number",
            description: "Max USDC to spend, defaults to 1.0",
            minimum: 0.01,
          },
        },
        required: ["url"],
      },
    },
  },

  /* ── Policy creation tools (store for later) ── */
  {
    type: "function",
    function: {
      name: "create_policy",
      description:
        "Store a scheduled, conditional, or recurring task in the database for later execution by the cron. Only use for non-immediate triggers.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Human-readable policy name",
          },
          trigger: {
            type: "object",
            description: "When to execute",
            properties: {
              type: {
                type: "string",
                enum: ["time", "price", "balance_above", "and"],
                description: "Trigger type",
              },
              /* time */
              schedule: {
                type: "string",
                enum: ["daily", "weekly", "monthly"],
              },
              dayOfWeek: { type: "number", minimum: 0, maximum: 6 },
              dayOfMonth: { type: "number", minimum: 1, maximum: 31 },
              lastDayOfMonth: { type: "boolean" },
              /* price */
              asset: {
                type: "string",
                enum: ["BTC", "ETH", "USDC", "EURC", "cirBTC"],
              },
              direction: { type: "string", enum: ["above", "below"] },
              threshold: { type: "number", minimum: 0.01 },
              /* balance_above */
              thresholdUsdc: { type: "number", minimum: 0.01 },
              /* and */
              conditions: {
                type: "array",
                items: { type: "object" },
                description: "Sub-triggers (no nested 'and')",
              },
            },
            required: ["type"],
          },
          executionMode: {
            type: "string",
            enum: ["once", "repeat"],
            description: "Run once or keep recurring",
          },
          steps: {
            type: "array",
            description: "Ordered plan to execute when triggered (max 3)",
            items: {
              type: "object",
              properties: {
                tool: {
                  type: "string",
                  enum: [
                    "send_usdc",
                    "send_token",
                    "swap_usdc",
                    "bridge_usdc",
                    "withdraw",
                    "pay_x402",
                  ],
                },
                params: { type: "object" },
              },
              required: ["tool", "params"],
            },
          },
          stopConditions: {
            type: "array",
            description: "Only for repeat mode",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["balance_below", "expires_at", "max_executions", "max_total_spend"],
                },
                thresholdUsdc: { type: "number" },
                date: { type: "string" },
                count: { type: "number" },
                amountUsdc: { type: "number" },
              },
            },
          },
        },
        required: ["description", "trigger", "executionMode", "steps"],
      },
    },
  },

  /* ── Conversation fallback ── */
  {
    type: "function",
    function: {
      name: "chat_response",
      description:
        "Use for financial conversation, explanations, or when the user did not request a wallet action. NOT for actual transactions.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Friendly, conversational reply to the user",
          },
        },
        required: ["message"],
      },
    },
  },
];

/* ──────────────────────────────────────────────────────────────────── */
/*  API CALL — what we send to OpenRouter                              */
/* ──────────────────────────────────────────────────────────────────── */

// Before (V3):
//   messages: [
//     { role: "system", content: buildSystemPromptV3(context) },  // ~3,000 tokens
//     ...history,
//     { role: "user", content: instruction }
//   ]

// After (V4):
//   messages: [
//     { role: "system", content: SYSTEM_PROMPT_V4 },            // ~30 tokens
//     ...history,
//     { role: "user", content: instruction }
//   ],
//   tools: TOOLS_V4,                                              // ~350 tokens
//   tool_choice: "required"

/* ──────────────────────────────────────────────────────────────────── */
/*  SAMPLE OUTPUT — what the LLM returns                               */
/* ──────────────────────────────────────────────────────────────────── */

// User: "send 10 USDC to john"
// LLM returns:
// {
//   "tool_calls": [
//     { "function": { "name": "send_usdc", "arguments": '{"recipient":"john.arc","amount":10}' } }
//   ]
// }

// User: "send 10 EURC to john" (wallet has 2 EURC, 50 USDC)
// LLM returns:
// {
//   "tool_calls": [
//     { "function": { "name": "swap_usdc", "arguments": '{"tokenIn":"USDC","tokenOut":"EURC","amount":8.5}' } },
//     { "function": { "name": "send_token", "arguments": '{"token":"EURC","recipient":"john.arc","amount":10}' } }
//   ]
// }
// No $prev. The engine executes swap first, then uses actual amountOut for send.

// User: "every Saturday send 5 USDC to cryptolympus"
// LLM returns:
// {
//   "tool_calls": [
//     { "function": { "name": "create_policy", "arguments": '{"description":"Weekly Saturday send","trigger":{"type":"time","schedule":"weekly","dayOfWeek":6},"executionMode":"repeat","steps":[{"tool":"send_usdc","params":{"recipient":"cryptolympus.arc","amount":5}}]}' } }
//   ]
// }

// User: "what's the price of Bitcoin?"
// LLM returns:
// {
//   "tool_calls": [
//     { "function": { "name": "chat_response", "arguments": '{"message":"I don\u0027t have live price feeds yet. For Bitcoin prices, check CoinGecko or your exchange. Want me to set a price alert instead?"}' } }
//   ]
// }

/* ──────────────────────────────────────────────────────────────────── */
/*  TOKEN COUNT COMPARISON (approximate)                               */
/* ──────────────────────────────────────────────────────────────────── */

// V3 prose prompt (with a typical context payload):
//   ~3,000 tokens  →  $0.0075 per call (Claude Sonnet 4 @ $2.50/M input)
//
// V4 function calling:
//   System prompt:  ~30 tokens
//   Tools schema:   ~350 tokens
//   Total:         ~380 tokens  →  $0.00095 per call
//
// Savings per interpret call: ~87% cheaper
// At 100 calls/day: $0.75/day → $0.095/day

export { SYSTEM_PROMPT_V4, TOOLS_V4 };
