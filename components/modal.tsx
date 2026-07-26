"use client";

// The app's dialog primitive. Everything modal goes through here so the
// behaviour people expect — Escape, click-outside, a focus trap, a locked
// background, screen-reader semantics — exists once and behaves identically
// everywhere, including when dialogs are stacked (list → detail → confirm).
//
// Structure note: `Modal` renders nothing when closed and defers to
// `ModalInner` when open. That split is deliberate — every effect below then
// runs on a real mount/unmount, so there are no `if (open)` guards inside
// hooks, focus restoration happens naturally on unmount, and `document` is
// never touched while the dialog is closed.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icon";

export type ModalSize = "md" | "lg" | "xl";
export type ModalLevel = "base" | "stacked" | "confirm";

const SIZE: Record<ModalSize, string> = {
  md: "max-w-[480px]",
  lg: "max-w-[720px]",
  xl: "max-w-[1120px]",
};

// Above every existing overlay in the app (sidebar toast is the highest, z-80).
// One positioned element per dialog, so these are globally comparable.
const LEVEL: Record<ModalLevel, string> = {
  base: "z-[100]",
  stacked: "z-[110]",
  confirm: "z-[120]",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),details summary,[tabindex]:not([tabindex="-1"])';

// ── Cross-instance coordination ─────────────────────────────────────────────
// Only the TOP dialog may react to Escape or trap Tab; otherwise an outer
// dialog steals focus back from the one the user is actually looking at, and a
// single Escape collapses the whole stack.
const stack: string[] = [];

// Background scroll is locked by REFERENCE COUNT, so closing an inner dialog
// while an outer one is still open doesn't hand scrolling back to the page.
let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function lockScroll() {
  if (lockCount++ > 0) return;
  const { body, documentElement } = document;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;
  // Compensate for the scrollbar the lock removes, or the whole page (and the
  // sticky header) jumps sideways the moment a dialog opens.
  const gap = window.innerWidth - documentElement.clientWidth;
  if (gap > 0) body.style.paddingRight = `${gap}px`;
  body.style.overflow = "hidden";
  // Known trade-off: overflow:hidden doesn't fully stop iOS Safari
  // rubber-banding. The usual fix (position:fixed + top offset) breaks scroll
  // restoration and gets worse with stacked dialogs, so we accept a little
  // bounce and rely on overscroll-contain on the scrolling body instead.
}

function unlockScroll() {
  if (--lockCount > 0) return;
  lockCount = 0;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPaddingRight;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: IconName;
  size?: ModalSize;
  level?: ModalLevel;
  /** Phones: "fullscreen" gives an edge-to-edge sheet; "center" keeps a card. */
  mobile?: "center" | "fullscreen";
  /** Rendered in the header, below the title — filters, counts, tabs. */
  headerExtra?: ReactNode;
  /** Pinned below the scroll area — actions, pagination. */
  footer?: ReactNode;
  bodyClassName?: string;
  closeOnOverlayClick?: boolean;
  children: ReactNode;
}

export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalInner {...props} />;
}

function ModalInner({
  onClose,
  title,
  subtitle,
  icon,
  size = "lg",
  level = "base",
  mobile = "center",
  headerExtra,
  footer,
  bodyClassName = "p-6",
  closeOnOverlayClick = true,
  children,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // An overlay click only counts when the press STARTED on the overlay too —
  // otherwise selecting text inside the panel and releasing outside closes it.
  const pressedOverlay = useRef(false);

  const isTop = () => stack[stack.length - 1] === id;

  useEffect(() => {
    stack.push(id);
    lockScroll();
    const opener = document.activeElement;
    // Focus the panel itself, never the close button: a keyboard user's
    // reflexive Enter would otherwise dismiss the dialog immediately.
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (!isTop()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // Re-query every time — the list dialog's contents change as rows load.
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      unlockScroll();
      // Restore focus only if the opener is still in the document — after a
      // stacked close the original element may be gone, and focusing a
      // detached node silently drops focus to <body>.
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
    // onClose is intentionally read fresh via closure on each event; the effect
    // must run exactly once per mount so the stack/lock stay balanced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Belt-and-braces: these are client components, but Next still prerenders
  // them on the server, where `document` doesn't exist.
  if (typeof document === "undefined") return null;

  const panelShape =
    mobile === "fullscreen"
      ? "h-[100dvh] w-full rounded-none sm:h-auto sm:max-h-[88dvh] sm:rounded-[12px]"
      : "max-h-[88dvh] rounded-[12px]";

  return createPortal(
    <div
      ref={overlayRef}
      className={`modal-overlay fixed inset-0 ${LEVEL[level]} bg-black/40 dark:bg-black/60 flex items-center justify-center ${
        mobile === "fullscreen" ? "p-0 sm:p-4" : "p-4"
      }`}
      onMouseDown={(e) => {
        pressedOverlay.current = e.target === overlayRef.current;
      }}
      onClick={(e) => {
        if (!closeOnOverlayClick) return;
        if (e.target === overlayRef.current && pressedOverlay.current) onClose();
        pressedOverlay.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descId : undefined}
        tabIndex={-1}
        className={`modal-panel card shadow-card-hover w-full ${SIZE[size]} ${panelShape} flex flex-col overflow-hidden outline-none`}
      >
        <div className="px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex items-start gap-3">
              {icon && (
                <span className="mt-0.5 text-accent shrink-0">
                  <Icon name={icon} size={20} />
                </span>
              )}
              <div className="min-w-0">
                <h2 id={titleId} className="font-headline text-lg text-text-primary truncate">
                  {title}
                </h2>
                {subtitle && (
                  <p id={descId} className="text-xs text-text-muted mt-0.5">
                    {subtitle}
                  </p>
                )}
              </div>
            </div>
            <button onClick={onClose} className="btn-icon shrink-0" aria-label="Close dialog">
              <Icon name="close" size={20} />
            </button>
          </div>
          {headerExtra && <div className="mt-3">{headerExtra}</div>}
        </div>

        {/* min-h-0 is load-bearing: without it this flex child refuses to
            shrink and the scroll area never appears. */}
        <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain ${bodyClassName}`}>
          {children}
        </div>

        {footer && <div className="shrink-0 border-t border-border">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
