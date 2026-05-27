import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        clash: ["'Clash Display'", "system-ui", "sans-serif"],
        geist: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        usdc: "#2775CA",
        gold: "#c9a96e",
      },
      keyframes: {
        scan: {
          "0%":   { top: "8px" },
          "50%":  { top: "calc(100% - 8px)" },
          "100%": { top: "8px" },
        },
      },
      animation: {
        scan: "scan 2.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
