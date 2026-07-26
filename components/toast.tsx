"use client";

// App-wide feedback: transient toasts, and a promise-based confirm that runs on
// the real dialog primitive.
//
// Both replace browser natives that were actively harmful here. `alert()` was
// the ONLY error path for a dozen actions, and two of those fire from inside a
// focus-trapped modal — a native alert yanks focus out of the trapped panel and
// blocks the whole thread, so the dialog behind it freezes mid-interaction.
// `window.confirm()` gated the four most destructive actions in the app (run
// the pipeline, delete a register, send an email, delete a user) with a
// dialog that can't say which one, can't be styled, and on some mobile browsers
// offers a "prevent this page from creating more dialogs" checkbox that
// silently auto-confirms everything afterwards.
//
// Toasts are portalled to <body> deliberately: the sidebar sets a `translate`,
// which makes it a containing block for fixed descendants, and anything
// rendered inside it positions against an off-screen drawer on mobile.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icon";
import { Modal } from "@/components/modal";

export type ToastKind = "success" | "error" | "info";

export interface ToastOptions {
  /** Errors stay until dismissed by default — see DURATION. */
  durationMs?: number;
  /** Secondary line, e.g. the underlying error message. */
  detail?: string;
}

interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ConfirmOptions {
  title: string;
  /** The consequence, in plain words. Shown as the dialog body. */
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon, for anything destructive. */
  destructive?: boolean;
}

interface ToastApi {
  toast: (kind: ToastKind, message: string, opts?: ToastOptions) => void;
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastApi | null>(null);

// A success is self-evident and can fade; an error the user didn't see is the
// failure mode this whole module exists to fix, so it waits to be dismissed.
const DURATION: Record<ToastKind, number> = {
  success: 5000,
  info: 6000,
  error: 0, // 0 = sticky
};

const TONE: Record<ToastKind, { icon: IconName; ring: string }> = {
  success: { icon: "check_circle", ring: "bg-success-soft text-success" },
  error: { icon: "error", ring: "bg-danger-soft text-danger" },
  info: { icon: "info", ring: "bg-info-soft text-info" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [request, setRequest] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, message: string, opts: ToastOptions = {}) => {
      const id = nextId.current++;
      // Cap the stack: a loop that fails 40 times should not paper over the UI.
      setItems((prev) => [...prev.slice(-3), { id, kind, message, ...opts }]);
      const ms = opts.durationMs ?? DURATION[kind];
      if (ms > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms)
        );
      }
    },
    [dismiss]
  );

  // Clear pending timers if the tree unmounts mid-countdown.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...opts, resolve })),
    []
  );

  function settle(value: boolean) {
    request?.resolve(value);
    setRequest(null);
  }

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (m, o) => toast("success", m, o),
      error: (m, o) => toast("error", m, o),
      info: (m, o) => toast("info", m, o),
      confirm,
    }),
    [toast, confirm]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {items.length > 0 &&
        typeof document !== "undefined" &&
        createPortal(
          // z-[130] sits above the confirm dialog (z-120): a toast raised BY a
          // confirmed action must be visible while that dialog is still closing.
          <div
            className="fixed inset-x-4 bottom-4 sm:inset-x-auto sm:right-6 sm:bottom-6 z-[130] flex flex-col gap-2 sm:w-[380px] pointer-events-none"
            role="region"
            aria-label="Notifications"
          >
            {items.map((t) => (
              <div
                key={t.id}
                role={t.kind === "error" ? "alert" : "status"}
                aria-live={t.kind === "error" ? "assertive" : "polite"}
                className="modal-panel pointer-events-auto card shadow-card-hover border border-border px-4 py-3 flex items-start gap-3"
              >
                <div
                  className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${TONE[t.kind].ring}`}
                >
                  <Icon name={TONE[t.kind].icon} size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-primary font-medium break-words">{t.message}</p>
                  {t.detail && (
                    <p className="text-xs text-text-muted mt-0.5 break-words">{t.detail}</p>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  className="btn-icon shrink-0 -mr-1 -mt-1"
                  aria-label="Dismiss notification"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>,
          document.body
        )}

      <Modal
        open={!!request}
        onClose={() => settle(false)}
        title={request?.title ?? ""}
        icon={request?.destructive ? "warning" : "help"}
        level="confirm"
        size="md"
        mobile="center"
        bodyClassName="p-6"
      >
        <div className="text-sm text-text-secondary space-y-3">{request?.body}</div>
        <div className="flex items-center justify-end gap-3 pt-6">
          <button onClick={() => settle(false)} className="btn btn-secondary">
            {request?.cancelLabel ?? "Cancel"}
          </button>
          <button
            onClick={() => settle(true)}
            className={request?.destructive ? "btn btn-destructive" : "btn btn-primary"}
          >
            {request?.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </Modal>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider> (see dashboard-shell.tsx)");
  }
  return ctx;
}

// Convenience for the near-universal catch block: surfaces the message rather
// than "[object Object]", which is what String(e) gives for a thrown object.
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
}
