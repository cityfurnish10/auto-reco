"use client";

// Selection checkboxes for table rows and cards.
//
// Native <input type="checkbox"> on purpose — it gets keyboard, screen-reader
// semantics, and the OS's own touch target for free, which a div-with-role
// reimplementation would have to earn back. accent-color tints it with the
// theme without needing a custom-drawn control.

import { useEffect, useRef } from "react";

export function RowCheckbox({
  checked,
  onChange,
  label,
  className = "",
}: {
  checked: boolean;
  /** shiftKey is forwarded so callers can implement range-select. */
  onChange: (shiftKey: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      // onClick, not onChange: it's the only one carrying shiftKey, and React
      // still fires it for keyboard activation (Space) with shiftKey false.
      onClick={(e) => {
        e.stopPropagation();
        onChange(e.shiftKey);
      }}
      onChange={() => {}}
      // Stop a click on the box from also opening the row's detail dialog.
      onMouseDown={(e) => e.stopPropagation()}
      className={`w-4 h-4 accent-[var(--color-accent)] cursor-pointer align-middle ${className}`}
    />
  );
}

export function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // `indeterminate` is a DOM property with no HTML attribute, so it can only be
  // set imperatively — this is the dash state meaning "some of this page".
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      title={label}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer align-middle"
    />
  );
}
