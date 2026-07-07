/**
 * scripts/solana-smoke.ts — one-command smoke test for the Solana send pipeline.
 *
 * Exercises the SAME engine the SEND_SOLANA_USDC skill uses (lib/solana/*),
 * but BYPASSES the chat → interpret → confirm-policy → PIN flow so you can prove
 * "can the agent wallet read balances and move USDC on devnet?" in one shot.
 *
 * It does NOT touch spend limits, agent_spend_log, idempotency, or sessions —
 * it is a developer smoke test, not a production path. For the real, guarded
 * flow, go through POST /api/agent/confirm-policy.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 *   1. Activate the Solana wallet once (creates the Circle SOL-DEVNET wallet):
 *        POST /api/agent/activate-solana          (via the app, logged in)
 *      or, here:  npm run solana:smoke -- activate --user <supabase-user-uuid>
 *   2. Fund the printed address with devnet SOL (>= 0.005, for fees) + devnet USDC.
 *   3. Make sure SOLANA_USDC_MINT matches the faucet you used.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   npm run solana:smoke -- balance
 *   npm run solana:smoke -- balance --address <base58>
 *   npm run solana:smoke -- send <recipient-base58> <amount>          # DRY RUN
 *   npm run solana:smoke -- send <recipient-base58> <amount> --yes    # BROADCASTS
 *
 *   Wallet resolution (first match wins):
 *     --wallet-id <id> / --address <base58>     explicit flags
 *     SOLANA_WALLET_ID / SOLANA_WALLET_ADDRESS  env vars
 *     DB lookup in agent_wallets (blockchain='SOL-DEVNET'); --user <uuid> to disambiguate
 *
 * Env required: same as the app (.env.local). Run via the npm script so it gets
 * --conditions=react-server (so `server-only` imports resolve) + --env-file.
 */

import "./_env"; // MUST be first — loads .env.local before lib/* reads env
import { PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";

import { getSolanaConnection } from "../lib/solana/connection";
import { assertSolForFees } from "../lib/solana/fees";
import { readUsdcBalance, buildUsdcTransferIxs } from "../lib/solana/spl";
import { signAndBroadcast } from "../lib/solana/sign";
import {
  SOLANA_RPC_URL,
  SOLANA_USDC_MINT,
  SOLANA_MIN_FEE_LAMPORTS,
  solanaExplorerTx,
} from "../lib/solana/config";

// ── Tiny arg parser ────────────────────────────────────────────────────────

type Args = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  const command = positionals.shift() ?? "balance";
  return { command, positionals, flags };
}

function isBase58Pubkey(s: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Wallet resolution ──────────────────────────────────────────────────────

type ResolvedWallet = { walletId: string; address: string; source: string };

function serviceSupabaseOrNull() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveWallet(flags: Args["flags"]): Promise<ResolvedWallet> {
  // 1. Explicit flags
  const flagAddr = typeof flags.address === "string" ? flags.address : undefined;
  const flagId = typeof flags["wallet-id"] === "string" ? (flags["wallet-id"] as string) : undefined;
  if (flagAddr || flagId) {
    return {
      walletId: flagId ?? "",
      address: flagAddr ?? "",
      source: "flags",
    };
  }

  // 2. Env vars
  if (process.env.SOLANA_WALLET_ADDRESS || process.env.SOLANA_WALLET_ID) {
    return {
      walletId: process.env.SOLANA_WALLET_ID ?? "",
      address: process.env.SOLANA_WALLET_ADDRESS ?? "",
      source: "env",
    };
  }

  // 3. DB lookup
  const supabase = serviceSupabaseOrNull();
  if (!supabase) {
    die(
      "No wallet given and can't reach Supabase (need NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY). Pass --address (and --wallet-id for send).",
    );
  }
  let q = supabase
    .from("agent_wallets")
    .select("circle_wallet_id, circle_wallet_address, user_id")
    .eq("blockchain", "SOL-DEVNET");
  const user = typeof flags.user === "string" ? flags.user : undefined;
  if (user) q = q.eq("user_id", user);

  const { data, error } = await q;
  if (error) die(`Supabase lookup failed: ${error.message}`);
  if (!data || data.length === 0) {
    die(
      "No SOL-DEVNET wallet in agent_wallets. Activate first:\n" +
        "  npm run solana:smoke -- activate --user <supabase-user-uuid>\n" +
        "or POST /api/agent/activate-solana from the logged-in app.",
    );
  }
  if (data.length > 1) {
    console.error("Multiple SOL-DEVNET wallets found — pass --user <uuid> or --address:");
    for (const r of data) {
      console.error(`  user=${r.user_id}  ${r.circle_wallet_address}`);
    }
    process.exit(1);
  }
  return {
    walletId: data[0].circle_wallet_id,
    address: data[0].circle_wallet_address,
    source: "db",
  };
}

// ── Commands ────────────────────────────────────────────────────────────────

async function printBalances(address: string): Promise<{ sol: number; usdc: number }> {
  const connection = getSolanaConnection();
  const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
  const sol = lamports / 1e9;
  const usdc = await readUsdcBalance(connection, address);
  const minSol = SOLANA_MIN_FEE_LAMPORTS / 1e9;
  const feesOk = lamports >= SOLANA_MIN_FEE_LAMPORTS;

  console.log(`  RPC:        ${SOLANA_RPC_URL}`);
  console.log(`  USDC mint:  ${SOLANA_USDC_MINT}`);
  console.log(`  Address:    ${address}`);
  console.log(`  SOL:        ${sol.toFixed(6)}  (min for fees: ${minSol.toFixed(4)})  ${feesOk ? "✓" : "✗ NEEDS SOL"}`);
  console.log(`  USDC:       ${usdc.toFixed(6)}`);
  return { sol, usdc };
}

async function cmdBalance(w: ResolvedWallet): Promise<void> {
  if (!w.address) die("balance needs an address (--address, env, or DB).");
  console.log(`→ Balance  (wallet from ${w.source})`);
  await printBalances(w.address);
}

async function cmdSend(w: ResolvedWallet, args: Args): Promise<void> {
  const [recipient, amountStr] = args.positionals;
  if (!recipient || !amountStr) {
    die("Usage: send <recipient-base58> <amount> [--yes]");
  }
  if (!w.address) die("send needs the sender address (--address, env, or DB).");
  if (!isBase58Pubkey(recipient)) die(`"${recipient}" is not a valid Solana address.`);
  if (recipient === w.address) die("Refusing to send to the wallet's own address.");

  const amount = parseFloat(parseFloat(amountStr).toFixed(6));
  if (!isFinite(amount) || amount <= 0) die(`Invalid amount: ${amountStr}`);

  const broadcast = args.flags.yes === true;
  const connection = getSolanaConnection();

  console.log(`→ Send ${amount} USDC  (wallet from ${w.source})`);
  const { usdc } = await printBalances(w.address);
  console.log(`  Recipient:  ${recipient}`);

  // Same pre-checks the skill runs.
  try {
    await assertSolForFees(connection, w.address);
  } catch (err) {
    die(err instanceof Error ? err.message : "SOL-for-fees check failed");
  }
  if (amount > usdc) {
    die(`Not enough USDC: have ${usdc.toFixed(6)}, need ${amount}.`);
  }

  if (!broadcast) {
    console.log("\n  DRY RUN — all pre-checks passed. Re-run with --yes to broadcast.");
    return;
  }

  if (!w.walletId) {
    die("Broadcasting needs the Circle wallet id (--wallet-id, SOLANA_WALLET_ID, or DB lookup).");
  }

  console.log("\n  Building → Circle-signing → broadcasting → confirming…");
  const instructions = buildUsdcTransferIxs({
    fromOwner: w.address,
    toOwner: recipient,
    amount,
  });
  const { signature } = await signAndBroadcast({
    walletId: w.walletId,
    feePayer: w.address,
    instructions,
    memo: `smoke send ${amount} USDC`,
  });

  console.log(`\n✓ Confirmed.`);
  console.log(`  tx:       ${signature}`);
  console.log(`  explorer: ${solanaExplorerTx(signature)}`);
}

async function cmdActivate(args: Args): Promise<void> {
  // Lazy import — only this command needs Circle wallet creation + a DB write.
  const { createAgentWalletInCircle } = await import("../lib/agent");

  console.log("→ Activate Solana wallet (Circle SOL-DEVNET)");
  const { walletId, address } = await createAgentWalletInCircle("SOL-DEVNET");
  if (!isBase58Pubkey(address)) die(`Circle returned a non-base58 address: ${address}`);
  console.log(`  walletId: ${walletId}`);
  console.log(`  address:  ${address}`);

  const user = typeof args.flags.user === "string" ? args.flags.user : undefined;
  if (!user) {
    console.log(
      "\n  (no --user given) Not persisted to agent_wallets. To save it, insert a row with\n" +
        "  blockchain='SOL-DEVNET', or re-run with --user <supabase-user-uuid>.",
    );
  } else {
    const supabase = serviceSupabaseOrNull();
    if (!supabase) die("Can't persist: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    const { error } = await supabase.from("agent_wallets").insert({
      user_id: user,
      blockchain: "SOL-DEVNET",
      circle_wallet_id: walletId,
      circle_wallet_address: address,
    });
    if (error) die(`DB insert failed: ${error.message}`);
    console.log(`\n  ✓ Persisted to agent_wallets for user ${user}.`);
  }
  console.log("\n  Next: fund this address with devnet SOL (>= 0.005) + devnet USDC.");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "balance": {
      const w = await resolveWallet(args.flags);
      await cmdBalance(w);
      break;
    }
    case "send": {
      const w = await resolveWallet(args.flags);
      await cmdSend(w, args);
      break;
    }
    case "activate": {
      await cmdActivate(args);
      break;
    }
    default:
      die(`Unknown command "${args.command}". Use: balance | send | activate`);
  }
}

main().catch((err) => {
  console.error("✗ Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
