import { resolveName, normalizeName } from "@/lib/ans";
import Link from "next/link";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://wallet.dotarc.my";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function PayPage({ params }: Props) {
  const { name: rawName } = await params;

  // Determine if this is a 0x address or a .arc name
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(rawName);

  let label: string | null = null;
  let address: string | null = null;

  if (isAddress) {
    address = rawName;
  } else {
    try {
      label = normalizeName(rawName);
      address = await resolveName(label);
    } catch {
      address = null;
    }
  }

  const displayName = label ? `${label}.arc` : null;
  const shortAddr = address
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : null;
  const walletDeepLink = `${APP_URL}/wallet`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-zinc-900">
        {/* Header stripe */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-blue-100">
            Synesis · Arc Testnet
          </div>
          {displayName ? (
            <div className="mt-1 text-2xl font-bold text-white">
              <span className="opacity-90">{displayName.split(".")[0]}</span>
              <span className="opacity-60">.arc</span>
            </div>
          ) : (
            <div className="mt-1 text-lg font-bold text-white">
              {shortAddr ?? "Unknown wallet"}
            </div>
          )}
        </div>

        <div className="p-6">
          {address ? (
            <>
              <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                  Wallet address
                </div>
                <div className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {address}
                </div>
              </div>

              <p className="mt-3 text-center text-xs text-zinc-400">
                Send only <span className="font-medium">USDC</span> on{" "}
                <span className="font-medium">Arc Testnet</span> to this address.
              </p>

              <Link
                href={walletDeepLink}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
              >
                Open Synesis wallet to send
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </>
          ) : (
            <div className="py-4 text-center">
              <div className="text-4xl">🔍</div>
              <p className="mt-3 font-semibold">
                {label ? `${label}.arc` : rawName} not found
              </p>
              <p className="mt-1 text-sm text-zinc-500">
                This {label ? ".arc name" : "address"} doesn&apos;t resolve on Arc Testnet.
              </p>
              <Link
                href={walletDeepLink}
                className="mt-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                Go to Synesis →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export async function generateMetadata({ params }: Props) {
  const { name } = await params;
  return {
    title: `Pay ${name} · Synesis`,
    description: `Send USDC to ${name} on Arc Testnet via Synesis wallet`,
  };
}
