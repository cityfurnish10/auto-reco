import type { Config } from "tailwindcss";

// Design tokens sourced from the Stitch project
// "CityFurnish Reconciliation Platform" (projects/10972687884826805687),
// extended with a semantic/badge/shadow/radius layer + dark-mode support.
// Semantic + surface colors are wired to CSS custom properties defined in
// globals.css so both Tailwind utilities and hand-written CSS share one
// source of truth — see globals.css :root / [data-theme="dark"].
const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Carried over from the original Stitch palette ────────────────
        // These were hardcoded hexes and therefore did NOT follow the move to
        // the Cityfurnish brand — which left the SIDEBAR, the most visible
        // chrome on the platform, still wearing the old near-black while
        // everything around it had turned violet.
        //
        // Pointed at the brand here rather than fixed at each of the thirteen
        // call sites, so anything reaching for one of these names later lands
        // on the brand too instead of quietly reintroducing the old theme.
        primary: "var(--cf-violet, #4a36b3)",
        "primary-container": "var(--cf-violet, #4a36b3)",
        "on-primary": "#ffffff",
        // On the violet sidebar. #83829b was a grey-lavender chosen for a
        // near-black ground and measures poorly on violet.
        "on-primary-container": "#d6cffa",
        "on-primary-fixed": "var(--cf-violet, #4a36b3)",
        "on-primary-fixed-variant": "var(--cf-violet-dk, #3a27a0)",
        "primary-fixed": "var(--cf-wash, #f0eaff)",
        "primary-fixed-dim": "#c6bff0",
        secondary: "#5d5f5f",
        "secondary-container": "#dfe0e0",
        "on-secondary-container": "#616363",
        background: "#fcf8fa",
        "on-background": "#1c1b1d",
        surface: "#fcf8fa",
        "surface-dim": "#ddd9db",
        "surface-bright": "#fcf8fa",
        "surface-tint": "#5d5c74",
        "surface-variant": "#e5e1e3",
        "on-surface": "#1c1b1d",
        "on-surface-variant": "#47464c",
        "surface-container-lowest": "#ffffff",
        "surface-container-low": "#f6f2f4",
        "surface-container": "#f1edef",
        "surface-container-high": "#ebe7e9",
        "surface-container-highest": "#e5e1e3",
        outline: "#78767d",
        "outline-variant": "#c8c5cd",
        error: "var(--cf-err, #c0392b)",
        "error-container": "#fae3e0",
        "on-error": "#ffffff",
        "on-error-container": "#7d2419",
        // The brand's warn is a deep amber-brown, not the bright #f59e0b that
        // was here — which read as a different product's alert colour.
        warning: "var(--cf-warn, #7a5800)",
        "inverse-surface": "#313032",
        "inverse-on-surface": "#f4f0f2",
        "inverse-primary": "#c6c4df",

        // ── Theme-aware tokens (CSS vars, flip with [data-theme="dark"]) ──
        "surface-page": "var(--surface-page)",
        "surface-card": "var(--surface-card)",
        "surface-elevated": "var(--surface-elevated)",
        border: "var(--border-color)",
        accent: "var(--color-accent)",
        "accent-hover": "var(--color-accent-hover)",
        "accent-active": "var(--color-accent-active)",
        // These two were used across the app but never declared here, so
        // `bg-accent-soft` / `border-accent-soft` generated no CSS at all and
        // `text-white` on an accent fill failed contrast in dark mode.
        "accent-soft": "var(--color-accent-soft)",
        "on-accent": "var(--color-on-accent)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "text-disabled": "var(--text-disabled)",

        // Semantic status colors (foreground + soft background pair each).
        // The foregrounds MUST point at the -fg vars: --color-success,
        // --color-info and --color-neutral were never defined in globals.css,
        // so text-success / text-info / text-neutral silently rendered as
        // nothing wherever they were used.
        success: "var(--color-success-fg)",
        "success-soft": "var(--color-success-bg)",
        "status-warning": "var(--color-warning-fg)",
        "warning-soft": "var(--color-warning-bg)",
        danger: "var(--color-error-fg)",
        "danger-soft": "var(--color-error-bg)",
        info: "var(--color-info-fg)",
        "info-soft": "var(--color-info-bg)",
        neutral: "var(--color-neutral-fg)",
        "neutral-soft": "var(--color-neutral-bg)",
      },
      borderRadius: {
        // Named, explicit tokens — deliberately do NOT override Tailwind's
        // native `full` (9999px) so rounded-full stays a true circle
        // (previously overridden to 12px here, which broke every avatar).
        DEFAULT: "0.125rem",
        control: "8px",
        card: "12px",
        pill: "999px",
      },
      spacing: {
        "row-height-compact": "32px",
        "row-height-standard": "44px",
        "sidebar-width": "260px",
        "container-margin": "24px",
        gutter: "16px",
        // 4px base grid
        1.5: "4px",
        4.5: "12px",
      },
      fontFamily: {
        headline: ["var(--font-hanken)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
      },
      fontSize: {
        "headline-lg": [
          "24px",
          { lineHeight: "32px", letterSpacing: "-0.02em", fontWeight: "700" },
        ],
        "headline-md": [
          "18px",
          { lineHeight: "24px", letterSpacing: "-0.01em", fontWeight: "600" },
        ],
        "body-md": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        "body-sm": ["13px", { lineHeight: "18px", fontWeight: "400" }],
        "label-md": ["13px", { lineHeight: "16px", fontWeight: "500" }],
        "label-sm": ["11px", { lineHeight: "14px", fontWeight: "600" }],
        // Full brief type scale. NOTE: font-weight is deliberately NOT baked
        // into these tokens — a size utility that also forces a weight fights
        // any `font-medium`/`font-bold` on the same element and produces the
        // uneven/mismatched bolding this pass is fixing. Weight is always set
        // explicitly via a `font-*` class instead.
        // Raised the two smallest steps by 1px each (was 11/12). `text-sm` was
        // SMALLER than `text-base`, which inverts what the name implies, and it
        // carries real content — product names, variance names, the whole
        // mobile card. 11px secondary text on a warehouse phone in daylight is
        // not a readable floor. Hierarchy is unchanged: 12 < 13 < 14.
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["14px", { lineHeight: "20px" }],
        md: ["15px", { lineHeight: "22px" }],
        lg: ["18px", { lineHeight: "26px" }],
        xl: ["22px", { lineHeight: "28px" }],
        "2xl": ["28px", { lineHeight: "34px" }],
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
      },
    },
  },
  plugins: [],
};
export default config;
