import type { Metadata } from "next";
import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { CircleWalletProvider } from "./circle-wallet-context";

export const metadata: Metadata = {
  title: "Synesis Smart Wallet",
  description: "Your wallet. Your name. Nothing else. A USDC-native smart wallet where your identity is your .arc name.",
  icons: {
    icon: "/dotarc.png",
    apple: "/dotarc.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is required because Bitdefender/Grammarly
    // browser extensions inject attributes (bis_register, bis_skin_checked,
    // __processed_*) into <html> and <body> before React hydrates. The
    // attributes are harmless but produce noisy dev console warnings.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body
        suppressHydrationWarning
        className={`${GeistSans.variable} min-h-screen bg-background text-foreground antialiased`}
      >
        <CircleWalletProvider>
          <main>{children}</main>
        </CircleWalletProvider>
      </body>
    </html>
  );
}
