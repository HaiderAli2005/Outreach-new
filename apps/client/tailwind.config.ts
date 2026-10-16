import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    screens: { sm: "600px", md: "860px", lg: "1020px", xl: "1240px" },
    extend: {
      colors: {
        bg: { DEFAULT: "var(--bg)", 2: "var(--bg-2)", 3: "var(--bg-3)" },
        ink: { DEFAULT: "var(--ink)", 2: "var(--ink-2)", 3: "var(--ink-3)", 4: "var(--ink-4)" },
        gold: { DEFAULT: "var(--gold)", 2: "var(--gold-2)", deep: "var(--gold-deep)", soft: "var(--gold-soft)" },
        good: "var(--good)",
        warn: "var(--warn)",
        bad: "var(--bad)",
        line: { DEFAULT: "var(--line)", 2: "var(--line-2)" },
      },
      fontFamily: {
        sans: ["var(--f-body)"],
        display: ["var(--f-display)"],
        mono: ["var(--f-mono)"],
      },
      borderRadius: { sm: "var(--r-sm)", DEFAULT: "var(--r)", lg: "var(--r-lg)" },
      transitionTimingFunction: { ap: "cubic-bezier(.2,.7,.2,1)", "ap-out": "cubic-bezier(.16,1,.3,1)" },
    },
  },
  corePlugins: { ringWidth: false, ringColor: false, ringOffsetWidth: false, ringOffsetColor: false, ringOpacity: false, preflight: true },
  plugins: [],
};

export default config;
