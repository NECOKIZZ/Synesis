/**
 * lib/format-transactions.ts
 *
 * Pure, client-safe renderer for a RETRIEVE_TRANSACTIONS skill result.
 *
 * Shared by BOTH chat surfaces (app/wallet/wallet-shell.tsx and
 * app/agent/page.tsx) so the formatter cannot drift between them — a missing
 * `case "RETRIEVE_TRANSACTIONS"` in one surface's switch is exactly what
 * dropped the computed aggregate on the floor and rendered "✓ Done." (F-12).
 * One function, two callers.
 *
 * NO "server-only" import — this runs in the browser.
 */

type Aggregate = {
  count?: number;
  total_in_usdc?: number;
  total_out_usdc?: number;
  largest_in_usdc?: number;
  largest_out_usdc?: number;
};

export function formatRetrieveTransactions(
  result: Record<string, unknown> | undefined,
): string {
  const agg = (result?.aggregate ?? {}) as Aggregate;
  const count = agg.count ?? 0;
  if (count === 0) return "No matching transactions found for that.";

  const fmt = (n: number) => `${n.toFixed(2)} USDC`;
  const outUsdc = agg.total_out_usdc ?? 0;
  const inUsdc = agg.total_in_usdc ?? 0;
  const largestOut = agg.largest_out_usdc ?? 0;
  const largestIn = agg.largest_in_usdc ?? 0;

  const parts: string[] = [`Found ${count} transaction${count !== 1 ? "s" : ""}.`];
  if (outUsdc > 0) {
    parts.push(`Sent ${fmt(outUsdc)}${largestOut > 0 ? ` — largest single ${fmt(largestOut)}` : ""}.`);
  }
  if (inUsdc > 0) {
    parts.push(`Received ${fmt(inUsdc)}${largestIn > 0 ? ` — largest single ${fmt(largestIn)}` : ""}.`);
  }
  if (result?.aggregate_truncated === true) {
    parts.push("(Totals are approximate — a lot of history matched.)");
  }
  return parts.join(" ");
}
