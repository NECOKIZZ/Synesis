/**
 * Instant skeleton shown while /wallet compiles (dev) and while
 * CircleWalletProvider's refresh() is in-flight (prod). Replaces the old
 * "Loading…" text-only state so the user sees something the moment they
 * click "Enter Wallet".
 */

export default function WalletLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: "#3a6fb8" }}
    >
      <div className="flex flex-col items-center gap-5">
        {/* Logo mark */}
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm">
          <span
            className="font-clash text-2xl font-semibold text-white"
            style={{ fontFamily: "'Clash Display', sans-serif" }}
          >
            .arc
          </span>
        </div>

        {/* Spinner */}
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white"
          aria-hidden
        />

        <p
          className="font-clash text-xs uppercase tracking-[0.25em] text-white/80"
          style={{ fontFamily: "'Clash Display', sans-serif" }}
        >
          Opening your wallet…
        </p>
      </div>
    </div>
  );
}
