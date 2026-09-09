"use client";

// Registers the guard app's service worker (public/sw.js).
//
// Renders nothing. It exists as a component only because the gate layout is a
// server component and registration has to happen in the browser.
//
// SCOPE. Root, deliberately. Serving the worker from /scan/ scopes it to
// "/scan/" — which does NOT include "/scan", the guard app's actual URL and the
// target of every pairing link. It registered, activated, and controlled
// nothing. The dashboard is kept out inside public/sw.js instead, where the
// rule can be read and tested.
//
// FAILURE IS SILENT AND FINE. No service worker means the app behaves exactly
// as it did before — an ordinary website that needs a connection to open. It
// must never be the reason a guard cannot record a movement, so every path here
// swallows its error.

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // After load, so registration never competes with the first paint or the
    // camera coming up — a guard is usually mid-task within a second or two.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          // A waiting worker means a new deploy is sitting behind the open tab.
          // Guards leave the app open for a whole shift, so waiting for every
          // tab to close can strand a phone on an old build for days.
          if (reg.waiting) reg.waiting.postMessage("skip-waiting");
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            if (!next) return;
            next.addEventListener("statechange", () => {
              if (next.state === "installed" && navigator.serviceWorker.controller) {
                next.postMessage("skip-waiting");
              }
            });
          });
        })
        .catch(() => undefined);
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
