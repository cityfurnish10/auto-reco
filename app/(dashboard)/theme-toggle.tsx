"use client";

// Persists to the same localStorage key the pre-hydration script in
// app/layout.tsx reads on first paint (see THEME_INIT_SCRIPT there).
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";

const THEME_KEY = "cf-theme";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  // One-time read of the pre-hydration script's result (see THEME_INIT_SCRIPT
  // in app/layout.tsx) — must run in an effect since this component is
  // server-rendered first, where `document` doesn't reflect the client's
  // stored preference yet. Same pattern as lib/demo-store.tsx's hydration effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    localStorage.setItem(THEME_KEY, next ? "dark" : "light");
  }

  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="btn-icon"
    >
      <Icon name={dark ? "light_mode" : "dark_mode"} size={20} />
    </button>
  );
}
