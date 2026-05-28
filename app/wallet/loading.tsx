/**
 * Branded loading screen — ArcLoader with fun facts while wallet inits.
 */

import { ArcLoader } from "@/app/components/arc-loader";

export default function WalletLoading() {
  return (
    <div style={{ background: "#3a6fb8" }}>
      <ArcLoader size="full" label="Opening your wallet…" showFacts />
    </div>
  );
}
