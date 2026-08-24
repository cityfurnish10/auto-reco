// /gate/pair?t=<device token> — the phone claims its enrolment.
//
// The manager enrols on the dashboard and gets a one-time link. The guard's
// phone opens it once, stores the token, and never sees it again: the token is
// held hashed on the server, so a lost phone is revoked and re-enrolled rather
// than recovered.
//
// A link rather than a QR scan on purpose — pairing happens once, indoors, with
// a manager present, and something that can be sent over WhatsApp is the least
// that can go wrong.

"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setToken } from "@/lib/gate/client/api";

// The token arrives in the query string, so this subtree can only render on the
// client. Without the boundary Next tries to prerender it at build time and the
// build fails outright.
export default function PairPage() {
  return (
    <Suspense fallback={<Shell glyph="🔗" title="Pairing…" body="" />}>
      <Pair />
    </Suspense>
  );
}

function Pair() {
  const params = useSearchParams();
  const router = useRouter();
  // DERIVED, not stored. The token is present in the query on the very first
  // render, so putting it in state only to set it from an effect adds a
  // needless second render and an avoidable cascade.
  const token = params.get("t");
  const bad = !token;

  useEffect(() => {
    if (!token) return;
    setToken(token);
    // Straight into the app, replacing the entry so neither the device token
    // nor the Vercel bypass secret sits in the phone's history or survives in a
    // screenshot of the address bar. The bypass has already done its job by
    // this point -- Vercel set a cookie on the way in, so the app and its API
    // keep working from here without it.
    const id = setTimeout(() => router.replace("/scan"), 800);
    return () => clearTimeout(id);
  }, [token, router]);

  return bad
    ? <Shell glyph="⚠️" title="This link is incomplete"
             body="Ask your manager to send the pairing link again." />
    : <Shell glyph="🔗" title="Phone paired" body="Opening the gate register…" />;
}

function Shell({ glyph, title, body }: { glyph: string; title: string; body: string }) {
  return (
    <div className="gate">
      <div className="gbrand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/apple-icon.png" alt="Cityfurnish" width={26} height={26} className="mark" />
        <span className="name">Gate Check</span>
      </div>
      <div className="gcenter">
        <div className="ghero">
          <div className="gglyph">{glyph}</div>
          <h1>{title}</h1>
          {body && <p>{body}</p>}
        </div>
      </div>
    </div>
  );
}
