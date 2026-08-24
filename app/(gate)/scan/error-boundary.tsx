"use client";

// One place every unexpected failure in the guard app becomes visible.
//
// WHY THIS EXISTS. A render error in React unmounts the whole tree and leaves a
// blank white page — which is the least useful failure available: it names
// neither the problem nor the remedy, and is indistinguishable from a dead
// phone or a bad connection. Three fixes were attempted against exactly that
// symptom without ever seeing the underlying error, because nothing was
// catching it.
//
// It also installs handlers for the two throws React cannot see: an error
// raised outside rendering, and a promise nobody awaited. Between them these
// three cover essentially everything that can go wrong at runtime.
//
// The guard is told something short and useful. The detail is there for
// whoever they show the phone to.

import { Component, useEffect, useState, type ReactNode } from "react";

function Fallback({ detail, onReset }: { detail: string; onReset: () => void }) {
  return (
    <div className="gate">
      <div className="gbrand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/apple-icon.png" alt="Cityfurnish" width={26} height={26} className="mark" />
        <span className="name">Gate Check</span>
      </div>
      <div className="gbody">
        <div className="ghero">
          <div className="gglyph">⚠️</div>
          <h1>Something went wrong</h1>
          <p>Nothing you have already scanned is lost — it is saved on this phone.</p>
        </div>
        <details className="gcard col">
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Show details</summary>
          <p className="mono" style={{ marginTop: 10, fontSize: 12, wordBreak: "break-all" }}>
            {detail}
          </p>
        </details>
      </div>
      <div className="gfoot">
        <button className="gbtn primary" onClick={onReset}>Try again</button>
      </div>
    </div>
  );
}

interface State { error: string | null }

class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(e: unknown): State {
    return { error: e instanceof Error ? `${e.message}` : String(e) };
  }
  render() {
    return this.state.error
      ? <Fallback detail={this.state.error} onReset={() => location.reload()} />
      : this.props.children;
  }
}

/**
 * Catches what the boundary cannot: a throw from outside the render pass, and
 * an unhandled rejection. Both otherwise vanish into a console nobody on a
 * warehouse floor can open.
 */
function GlobalErrors({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onErr = (e: ErrorEvent) => setError(e.message || "Unknown error");
    const onRej = (e: PromiseRejectionEvent) =>
      setError(e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);
  return error
    ? <Fallback detail={error} onReset={() => { setError(null); location.reload(); }} />
    : <>{children}</>;
}

export default function GateErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary><GlobalErrors>{children}</GlobalErrors></Boundary>;
}
