"use client";

// Daily Email Digest preview (from the Stitch "Daily Email Digest" screen).
// Renders the exact email shell that Resend will send in Phase 5, driven by
// live sample summaries + the last reconciliation run. "Send test" is a demo
// toast today; becomes a real Resend call once email is wired.

import { useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import { CITY_SUMMARIES, OVERALL } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

const ACCURACY_THRESHOLD = 90;

export default function EmailPreview() {
  const { lastRun } = useDemoStore();
  const [toast, setToast] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const rows = [...CITY_SUMMARIES].sort((a, b) => a.rank - b.rank);
  const highTotal = rows.reduce(
    (s, c) => s + Math.round((c.highPct / 100) * c.openVariances),
    0
  );
  const totalVariances = lastRun
    ? lastRun.total
    : rows.reduce((s, c) => s + c.openVariances, 0);

  function sendTest() {
    setToast("Test digest queued (demo) — Resend delivery arrives in Phase 5.");
    setTimeout(() => setToast(null), 5000);
  }

  return (
    <div className="p-container-margin">
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="font-headline text-xl text-text-primary">
            Daily Email Digest
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Preview of the 11:00 AM management report. Sent to the distribution
            list once email is wired (Phase 5).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip">
            <Icon name="schedule" size={16} />
            Scheduled 11:00 IST
          </span>
          <button onClick={sendTest} className="btn btn-primary">
            <Icon name="send" size={18} />
            Send Test
          </button>
        </div>
      </div>

      {/* Email shell */}
      <div className="mx-auto max-w-[600px] card overflow-hidden">
        {/* Header */}
        <header className="p-5 md:p-8border-b border-border bg-surface-card">
          <div className="flex items-center justify-between mb-6">
            <span className="font-headline text-xl font-black text-text-primary">
              CityFurnish
            </span>
            <span className="text-xs uppercase tracking-widest text-text-muted">
              Daily Digest
            </span>
          </div>
          <h2 className="font-headline text-lg text-text-primary mb-2">
            Daily Warehouse Reconciliation Report
          </h2>
          <p className="text-sm text-text-muted">
            {today} — here&apos;s how your cities performed today.
          </p>
        </header>

        {/* Metrics */}
        <section className="p-5 md:p-8bg-surface-elevated">
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="p-4 bg-surface-card border border-border rounded-control">
              <p className="text-xs text-text-muted mb-1">Global Accuracy</p>
              <p className="font-headline text-lg text-text-primary">
                {OVERALL.avgAccuracy}%
              </p>
            </div>
            <div className="p-4 bg-surface-card border border-border rounded-control">
              <p className="text-xs text-text-muted mb-1">Total Variances</p>
              <p className="font-headline text-lg text-text-primary">
                {totalVariances}
              </p>
            </div>
            <div className="p-4 bg-surface-card border border-border rounded-control">
              <p className="text-xs text-text-muted mb-1">High Severity</p>
              <p className="font-headline text-lg text-danger">
                {lastRun ? lastRun.highPriority : highTotal}
              </p>
            </div>
          </div>

          {/* City table */}
          <div className="overflow-hidden border border-border rounded-control">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>City</th>
                  <th className="text-right">Accuracy %</th>
                  <th className="text-right">Open</th>
                  <th className="text-right">High Sev</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const low = c.accuracy < ACCURACY_THRESHOLD;
                  const highCount = Math.round((c.highPct / 100) * c.openVariances);
                  return (
                    <tr key={c.city} className={low ? "bg-danger-soft" : ""}>
                      <td className={low ? "font-semibold text-danger" : "text-text-primary"}>
                        {c.city}
                      </td>
                      <td className={`text-right ${low ? "font-bold text-danger" : "text-text-primary"}`}>
                        {c.accuracy}%
                      </td>
                      <td className={`text-right ${low ? "text-danger" : "text-text-primary"}`}>
                        {c.openVariances}
                      </td>
                      <td className={`text-right ${low ? "text-danger" : "text-text-primary"}`}>
                        {highCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-text-muted mt-3">
            Cities below {ACCURACY_THRESHOLD}% accuracy are flagged red.
          </p>

          {/* CTA */}
          <div className="mt-10 text-center">
            <span className="inline-block bg-accent text-white px-8 py-4 text-sm rounded-control uppercase tracking-widest font-bold">
              View Full Dashboard →
            </span>
          </div>
        </section>

        {/* Footer */}
        <footer className="p-5 md:p-8border-t border-border bg-surface-elevated text-center">
          <p className="text-sm text-text-muted mb-4">
            This is an automated operational report generated by the CityFurnish
            Operations Portal. If you notice discrepancies, contact the Warehouse
            Reconciliation Team.
          </p>
          <p className="text-xs text-text-disabled">
            © {new Date().getFullYear()} CityFurnish Logistics · Internal use
            only.
          </p>
        </footer>
      </div>

      {toast && (
        <div className="fixed bottom-8 right-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <p className="text-sm">{toast}</p>
        </div>
      )}
    </div>
  );
}
