"use client";

// A date-range control with presets, validation and a data floor.
//
// Reusable rather than inline because four pages already hand-roll a bare
// <input type="date"> + .input-clean and do it inconsistently — and a RANGE adds
// three things worth having in one place: preset resolution, cross-field
// validation, and a floor with an explanation of why the start moved.
//
// Controlled and stateless. Stickiness belongs to the caller.

import { useId } from "react";

export interface DateRangeValue {
  from: string;
  to: string;
}

export interface DateRangePreset {
  label: string;
  days: number;
}

export const DEFAULT_PRESETS: DateRangePreset[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function shift(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

export function presetRange(preset: DateRangePreset, today: string): DateRangeValue {
  return { from: shift(today, -(preset.days - 1)), to: today };
}

export function DateRange({
  value,
  onChange,
  today,
  earliest,
  presets = DEFAULT_PRESETS,
  disabled = false,
  legend = "Date range",
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  /** Latest selectable day. */
  today: string;
  /** First day with any data. The start clamps here, and the UI says so. */
  earliest?: string | null;
  presets?: DateRangePreset[];
  disabled?: boolean;
  legend?: string;
}) {
  const id = useId();
  const invalid = value.from > value.to;
  const clamped = !!earliest && value.from < earliest;

  const activePreset = presets.find(
    (p) => value.to === today && presetRange(p, today).from === value.from
  );

  const set = (next: Partial<DateRangeValue>) => onChange({ ...value, ...next });

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="kpi-label mb-1">{legend}</legend>

      <div className="bg-surface-elevated rounded-control p-1 flex flex-wrap" role="radiogroup" aria-label={legend}>
        {presets.map((p) => {
          const active = activePreset?.label === p.label;
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(presetRange(p, today))}
              className={
                active
                  ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                  : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
              }
            >
              {p.label}
            </button>
          );
        })}
        <span
          role="radio"
          aria-checked={!activePreset}
          className={
            !activePreset
              ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
              : "px-4 py-1.5 text-sm text-text-secondary rounded-control"
          }
        >
          Custom
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-from`} className="text-xs text-text-muted">
          From
        </label>
        <input
          id={`${id}-from`}
          type="date"
          className="input-clean cursor-pointer"
          value={value.from}
          min={earliest ?? undefined}
          max={today}
          onChange={(e) => set({ from: e.target.value })}
        />
        <label htmlFor={`${id}-to`} className="text-xs text-text-muted">
          To
        </label>
        <input
          id={`${id}-to`}
          type="date"
          className="input-clean cursor-pointer"
          value={value.to}
          min={earliest ?? undefined}
          max={today}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>

      {/* Announced, because a silently-moved start date teaches people the control
          does things they did not ask for. */}
      <p role="status" aria-live="polite" className="text-xs text-text-muted min-h-4">
        {invalid ? (
          <span className="text-danger font-semibold">The start date is after the end date.</span>
        ) : clamped ? (
          `Records start on ${earliest}, so nothing before that will appear.`
        ) : (
          ""
        )}
      </p>
    </fieldset>
  );
}
