import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Server-only env vars are auto-loaded from .env.local.
  // NEXT_PUBLIC_* vars are auto-exposed to the browser.
  //
  // Force the Circle Web SDK to be transpiled by Next instead of left as a
  // dynamic-import chunk. Without this, dev builds 404 on
  // `_app-pages-browser_node_modules_circle-fin_w3s-pw-web-sdk_*.js` which
  // silently breaks the PIN-challenge step of signup.
  transpilePackages: ["@circle-fin/w3s-pw-web-sdk"],
};

export default nextConfig;
