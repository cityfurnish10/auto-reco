"use client";

// Header notification bell (admin only) — shows a live count of variances that
// city managers have submitted and are awaiting approval. Clicking it opens the
// dashboard filtered to the approval queue.

import { useEffect, useState } from "react";
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

  return (
    <a
      href="/dashboard?status=pending_approval"
      className="btn-icon relative hidden sm:inline-flex"
      title={count > 0 ? `${count} variance${count === 1 ? "" : "s"} awaiting approval` : "No pending approvals"}
    >
      <Icon name="notifications" size={20} />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </a>
  );
}
