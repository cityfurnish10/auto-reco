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
        primary: "#00000b",
        "primary-container": "#1a1a2e",
        "on-primary": "#ffffff",
        "on-primary-container": "#83829b",
        "on-primary-fixed": "#1a1a2e",
        "on-primary-fixed-variant": "#45455b",
        "primary-fixed": "#e2e0fc",
        "primary-fixed-dim": "#c6c4df",
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
        error: "#ba1a1a",
        "error-container": "#ffdad6",
        "on-error": "#ffffff",
        "on-error-container": "#93000a",
        warning: "#f59e0b",
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
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "text-disabled": "var(--text-disabled)",

        // Semantic status colors (foreground + soft background pair each)
        success: "var(--color-success)",
        "success-soft": "var(--color-success-bg)",
        "status-warning": "var(--color-warning-fg)",
        "warning-soft": "var(--color-warning-bg)",
        danger: "var(--color-error-fg)",
        "danger-soft": "var(--color-error-bg)",
        info: "var(--color-info)",
        "info-soft": "var(--color-info-bg)",
        neutral: "var(--color-neutral)",
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
        xs: ["11px", { lineHeight: "14px" }],
        sm: ["12px", { lineHeight: "16px" }],
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
