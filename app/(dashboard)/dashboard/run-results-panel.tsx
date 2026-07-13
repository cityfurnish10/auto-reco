"use client";

// Surfaces the actual reconciliation-engine output from the last run
// (Section 10/11 of the reco spec): REAL vs INFO split, by-variance
// breakdown, and the REAL variances to chase today. This reflects the real
// barcode-level engine — distinct from the illustrative quantity table below.

import { useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import type { City } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

export default function RunResultsPanel({
  cityFilter,
}: {
  cityFilter: "ALL" | City;
}) {
  const { lastRun } = useDemoStore();
  const [expanded, setExpanded] = useState(true);

  if (!lastRun) return null;

  const real = lastRun.realVariances.filter(
    (v) => cityFilter === "ALL" || v.city === cityFilter
  );

  const byVariance = Object.entries(lastRun.byVariance).sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <div className="card overflow-hidden">
      <div className="p-4 border-b border-border bg-accent text-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Icon name="fact_check" size={22} />
          <div>
            <h3 className="font-headline text-lg">
              Latest Reconciliation Run
            </h3>
            <p className="text-xs opacity-70">
              {lastRun.date} · engine output (barcode-level)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <div className="text-xl font-bold">
              {lastRun.realCount}
            </div>
            <div className="text-[9px] uppercase tracking-wider opacity-70">
              REAL — chase
            </div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold opacity-80">
              {lastRun.infoCount}
            </div>
            <div className="text-[9px] uppercase tracking-wider opacity-70">
              INFO — dampened
            </div>
          </div>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="btn-icon text-white/80! hover:text-white!"
          >
            <Icon name={expanded ? "expand_less" : "expand_more"} size={20} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {/* by-variance chips */}
          <div className="flex flex-wrap gap-2">
            {byVariance.map(([name, count]) => (
              <span key={name} className="chip">
                <span className="font-semibold text-text-primary">{count}</span>
                <span>{name}</span>
              </span>
            ))}
          </div>

          {/* REAL variance list (the actionable set) */}
          <div className="overflow-x-auto border border-border rounded-control">
            <table className="table-clean">
              <thead>
                <tr>
                  <th>Barcode</th>
                  <th>City</th>
                  <th>Dir</th>
                  <th>Variance</th>
                  <th>Priority</th>
                  <th>Owner</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {real.map((v, i) => (
                  <tr key={`${v.barcode}-${v.direction}-${i}`}>
                    <td className="font-mono font-semibold text-text-primary">
                      {v.barcode}
                    </td>
                    <td>{v.city}</td>
                    <td>
                      <span className="bg-surface-elevated text-text-secondary px-1.5 py-0.5 rounded text-xs font-bold">
                        {v.direction}
                      </span>
                    </td>
                    <td>{v.variance_name}</td>
                    <td>
                      <span
                        className={`badge ${
                          v.priority === "High"
                            ? "badge-high"
                            : v.priority === "Medium"
                              ? "badge-medium"
                              : "badge-suppressed"
                        }`}
                      >
                        {v.priority}
                      </span>
                    </td>
                    <td className="text-text-secondary">{v.responsible}</td>
                    <td className="max-w-[320px] truncate text-text-secondary" title={v.note}>
                      {v.note}
                    </td>
                  </tr>
                ))}
                {real.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-center py-6 text-text-muted"
                    >
                      No REAL variances to chase
                      {cityFilter !== "ALL" ? ` in ${cityFilter}` : ""} — clean run.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
