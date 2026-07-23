import type { Config } from "tailwindcss";

/**
 * Portal design tokens (Modal.com-inspired dark theme).
 *
 * - `surface`  — page/panel backgrounds, darkest to lightest.
 * - `line`     — hairline borders on dark surfaces.
 * - `ink`      — foreground text on dark surfaces.
 * - `brand`    — the signature lime green used for primary actions, active
 *                nav states and positive money values.
 * - `accent`   — sparing categorical pops (charts, secondary statuses).
 *
 * The admin area keeps the default light Tailwind palette; these tokens are
 * additive and only used inside the partner portal + login shell.
 */
const config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#121412",
          raised: "#191C18",
          overlay: "#20241F",
          inset: "#0D0F0D",
        },
        line: {
          DEFAULT: "#272B25",
          strong: "#343A31",
        },
        ink: {
          DEFAULT: "#EDF2EA",
          muted: "#9FAA9A",
          faint: "#6A7565",
        },
        brand: {
          DEFAULT: "#80EE64",
          soft: "#BFF9B4",
          deep: "#10A550",
        },
        accent: {
          coral: "#FF8E63",
          pink: "#FF7EB0",
          blue: "#4B73FF",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
