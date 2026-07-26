"use client";

// Header notification bell (admin only) — shows a live count of variances that
// city managers have submitted and are awaiting approval. Clicking it opens the
// dashboard filtered to the approval queue.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";

export default function ApprovalsBell() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/variances/pending-count", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { count: 0 }))
        .then((j) => {
          if (alive) setCount(j.count ?? 0);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000); // refresh every minute
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const label =
    count > 0
      ? `${count} variance${count === 1 ? "" : "s"} awaiting approval`
      : "No pending approvals";

  return (
    // next/link, not <a>: an anchor triggered a full document reload, throwing
    // away the client cache and re-running every fetch on the page.
    //
    // Visible on phones too. It was `hidden sm:inline-flex`, so an admin on a
    // phone — the device they actually carry round the warehouse — had no
    // indication that anything was waiting for them.
    <Link
      href="/dashboard?status=pending_approval"
      className="btn-icon relative"
      title={label}
      aria-label={label}
    >
      <Icon name="notifications" size={20} />
      {count > 0 && (
        <>
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[11px] font-bold flex items-center justify-center ring-2 ring-surface-card"
          >
            {count > 99 ? "99+" : count}
          </span>
          {/* Announced once when the count changes, rather than on every poll. */}
          <span className="sr-only" role="status">
            {label}
          </span>
        </>
      )}
    </Link>
  );
}
