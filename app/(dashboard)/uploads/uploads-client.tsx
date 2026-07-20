"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import type { SessionUser } from "@/lib/demo-auth";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { GuardUpload, UploadStatus } from "@/lib/db/schema";
import { CITIES, type City, type UploadStatus as DemoUploadStatus } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const DEMO_STATUS_BADGE: Record<DemoUploadStatus, string> = {
  PENDING: "badge badge-medium",
  UPLOADED: "badge badge-info",
  PARSED: "badge badge-done",
  ERROR: "badge badge-high",
};

const REAL_STATUS_BADGE: Record<UploadStatus, string> = {
  pending: "badge badge-medium",
  ocr_running: "badge badge-info",
  needs_review: "badge badge-medium",
  processed: "badge badge-done",
  failed: "badge badge-high",
};

const REAL_STATUS_LABEL: Record<UploadStatus, string> = {
  pending: "Queued for OCR",
  ocr_running: "Processing…",
  needs_review: "Processing…", // legacy rows; new flow never stops here
  processed: "Processed",
  failed: "Failed",
};

const MAX_SIZE_MB = 20;

export default function UploadsClient({ user }: { user: SessionUser }) {
  if (supabaseConfigured) {
    return <RealUploadsClient user={user} />;
  }
  return <DemoUploadsClient user={user} />;
}

// ─────────────────────────────────────────────────────────────────────────
// Real pipeline (no review step): PDF → Supabase Storage (signed URL) →
// guard_uploads row (status 'pending'). A background job (/api/cron/ocr, and a
// safety-net pass inside the reconcile cron) OCRs it, stores every row RAW, and
// marks it 'processed'. Those rows then feed reconciliation alongside the other
// three sources. The uploader just drops the file and walks away.
// ─────────────────────────────────────────────────────────────────────────
function RealUploadsClient({ user }: { user: SessionUser }) {
  const isManager = user.role === "MANAGER";
  const [selectedCity, setSelectedCity] = useState<City>(isManager ? user.city! : "DELHI");
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false); // OCR running right after upload
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<GuardUpload[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  // The date the register's gate movements happened (NOT the upload day) — this
  // is the business_date the register reconciles against, so it must match the
  // day Odoo/DT/Sheet are pulled for. Defaults to today for same-day uploads.
  const [registerDate, setRegisterDate] = useState(today);

  async function refreshHistory() {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("guard_uploads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    setHistory((data ?? []) as GuardUpload[]);
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    refreshHistory();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleFiles(files: FileList | null) {
    setUploadError(null);
    if (!files || files.length === 0) return;
    const file = files[0];

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only .pdf files are supported.");
      return;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setUploadError(`File exceeds the ${MAX_SIZE_MB}MB limit.`);
      return;
    }
    if (!registerDate) {
      setUploadError("Select the register date before uploading.");
      return;
    }

    setUploading(true);
    try {
      // business_date = the register's movement date (the date picker), so it
      // reconciles against the same day's Odoo / DT / ops-sheet data.
      const createRes = await fetch("/api/uploads/guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: selectedCity, businessDate: registerDate, fileName: file.name }),
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created.error ?? "failed to create upload");

      const supabase = getSupabaseClient();
      const { error: uploadErr } = await supabase.storage
        .from("guard-registers")
        .uploadToSignedUrl(created.filePath, created.token, file);
      if (uploadErr) throw new Error(uploadErr.message);

      // OCR it immediately (synchronous) and store the rows — no waiting for the
      // nightly run. This can take ~15–30s while Document Intelligence reads the PDF.
      setUploading(false);
      setProcessing(true);
      refreshHistory();
      const procRes = await fetch(`/api/uploads/guard/${created.id}/process`, {
        method: "POST",
        credentials: "same-origin",
      });
      const proc = await procRes.json();
      if (!procRes.ok) {
        throw new Error(proc.error ?? proc.reason ?? `OCR failed (HTTP ${procRes.status})`);
      }
      setToast(
        `"${file.name}" processed — ${proc.rows ?? 0} rows extracted and stored for ${selectedCity} (register dated ${registerDate}).`
      );
      setTimeout(() => setToast(null), 6000);
      refreshHistory();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
      refreshHistory();
    } finally {
      setUploading(false);
      setProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Admin-only: permanently remove a register — the PDF, its OCR'd rows in the
  // DB, and the Drive mirror. Requires an explicit confirm.
  async function handleDelete(u: GuardUpload) {
    if (
      !window.confirm(
        `Remove "${u.file_name}" (${u.city}, ${u.business_date})?\n\nThis permanently deletes the PDF and its OCR'd data from the database. It cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingId(u.id);
    setUploadError(null);
    try {
      const res = await fetch(`/api/uploads/guard/${u.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setToast(`Removed "${u.file_name}" and its OCR data.`);
      setTimeout(() => setToast(null), 6000);
      refreshHistory();
    } catch (e) {
      setUploadError(`Could not delete: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingId(null);
    }
  }

  const visibleHistory = useMemo(
    () => (isManager ? history.filter((u) => u.city === user.city) : history),
    [history, isManager, user.city]
  );

  return (
    <div className="p-container-margin">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="font-headline text-xl text-text-primary">Upload Guard Register</h2>
          <div className="flex items-center gap-2 mt-1 text-text-muted">
            <Icon name="location_on" size={18} />
            <span className="text-sm font-medium">{selectedCity} Warehouse</span>
            <span className="mx-2 text-text-disabled">•</span>
            <span className="text-sm">
              Register for {new Date(`${registerDate}T00:00:00`).toLocaleDateString("en-IN", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Register date — the day the movements happened, NOT the upload day. It
          becomes the guard_uploads.business_date the register reconciles on. */}
      <div className="card p-4 mb-8 flex flex-col sm:flex-row sm:items-center gap-3 border-l-[3px] border-l-accent">
        <div className="flex items-start gap-3 flex-1">
          <div className="p-2 bg-accent-soft text-accent rounded-control shrink-0">
            <Icon name="schedule" size={22} />
          </div>
          <div>
            <label htmlFor="register-date" className="block text-sm font-semibold text-text-primary">
              Register date <span className="text-danger">*</span>
            </label>
            <p className="text-xs text-text-muted mt-0.5">
              Select the date this register is <b>for</b> — the day these gate movements happened, as written at the top of the register. Use a past date if you&apos;re uploading an earlier day&apos;s register: it reconciles against that day&apos;s Odoo, DT and ops-sheet data, <b>not</b> today&apos;s.
            </p>
          </div>
        </div>
        <input
          id="register-date"
          type="date"
          value={registerDate}
          max={today}
          onChange={(e) => setRegisterDate(e.target.value)}
          className="input-clean cursor-pointer sm:w-52 shrink-0"
        />
      </div>

      {!isManager && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          {CITIES.map((c) => (
            <button
              key={c}
              onClick={() => setSelectedCity(c)}
              className={`card p-4 text-left transition-shadow duration-150 ${
                selectedCity === c ? "border-accent shadow-card-hover" : "hover:border-accent/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-headline text-sm font-bold text-text-primary">{c}</span>
                {selectedCity === c && (
                  <Icon name="check_circle" size={16} className="text-accent" />
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-12 gap-gutter">
        <section className="col-span-12 lg:col-span-8">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => !uploading && !processing && fileInputRef.current?.click()}
            className={`bg-surface-card border-2 border-dashed rounded-card p-8 md:p-16 flex flex-col items-center justify-center text-center transition-colors duration-150 ${
              uploading || processing ? "cursor-default" : "cursor-pointer"
            } ${dragOver ? "border-accent bg-surface-elevated" : "border-border hover:border-accent"}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            {uploading || processing ? (
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 border-4 border-accent-soft border-t-accent rounded-full animate-spin mb-4"></div>
                <p className="text-sm font-medium text-accent">
                  {uploading ? "Uploading…" : "Reading the register (OCR) — this takes a few seconds…"}
                </p>
              </div>
            ) : (
              <>
                <div className="w-20 h-20 bg-surface-elevated rounded-full flex items-center justify-center mb-6 border border-border">
                  <Icon name="cloud_upload" size={40} className="text-accent" />
                </div>
                <h3 className="font-headline text-lg text-text-primary mb-2">
                  Drag the register PDF here or click to browse
                </h3>
                <p className="text-sm text-text-muted mb-6">
                  Supports .pdf only (both IN and OUT pages in one file). Maximum {MAX_SIZE_MB}MB.
                </p>
                <button type="button" className="btn btn-secondary">
                  Browse Files
                </button>
              </>
            )}
          </div>

          {uploadError && (
            <div className="mt-4 flex items-center gap-3 p-4 bg-danger-soft rounded-card border border-danger/20">
              <Icon name="error" size={22} className="text-danger" />
              <p className="text-sm text-danger font-semibold">{uploadError}</p>
            </div>
          )}

          <div className="mt-6 flex items-start gap-3 p-4 bg-warning-soft rounded-card border border-status-warning/20">
            <Icon name="info" size={22} className="text-status-warning" />
            <div>
              <p className="text-sm text-status-warning font-semibold mb-0.5">How this works</p>
              <p className="text-sm text-text-secondary">
                Just drop the register PDF. It&apos;s stored securely and read by OCR
                <b> immediately</b> — the extracted rows are saved to the database within
                seconds (no manual review). They then feed the next reconciliation run
                alongside Odoo, DT and the movement sheet.
              </p>
            </div>
          </div>
        </section>

        <section className="col-span-12 lg:col-span-4">
          <div className="card p-6 h-full">
            <h4 className="font-headline text-lg text-text-primary mb-4">Quick Insights</h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-control flex items-center justify-center text-accent bg-accent-soft">
                    <Icon name="history" size={22} />
                  </div>
                  <span className="text-sm font-medium">Uploads Recorded</span>
                </div>
                <span className="text-sm font-bold">{visibleHistory.length}</span>
              </div>
              <div className="pt-4">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-3">
                  Validation Rules
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    .pdf format, ≤ {MAX_SIZE_MB}MB
                  </li>
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    OCR runs automatically — no manual review
                  </li>
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    One PDF may contain both IN and OUT pages
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12 mt-4">
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-surface-elevated">
              <h4 className="font-headline text-lg text-text-primary">
                Upload Status{isManager ? ` — ${user.city}` : " — All Cities"}
              </h4>
              <button onClick={refreshHistory} className="btn-icon" title="Refresh">
                <Icon name="refresh" size={18} />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="table-clean">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>File Name</th>
                    {!isManager && <th>City</th>}
                    <th>Status</th>
                    <th>Rows</th>
                    {!isManager && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map((u) => (
                    <tr key={u.id}>
                      <td className="text-text-secondary">{u.business_date}</td>
                      <td className="font-medium text-text-primary">{u.file_name}</td>
                      {!isManager && <td>{u.city}</td>}
                      <td>
                        <span className={REAL_STATUS_BADGE[u.status]}>
                          {REAL_STATUS_LABEL[u.status]}
                        </span>
                        {u.status === "failed" && u.error && (
                          <span className="block text-xs text-danger mt-1 max-w-[240px] truncate" title={u.error}>
                            {u.error}
                          </span>
                        )}
                      </td>
                      <td className="text-text-secondary">{u.rows_parsed || "—"}</td>
                      {!isManager && (
                        <td className="text-right">
                          <button
                            onClick={() => handleDelete(u)}
                            disabled={deletingId === u.id}
                            title="Delete this register (PDF + OCR data)"
                            className="btn-icon hover:text-danger disabled:opacity-40"
                          >
                            <Icon name={deletingId === u.id ? "progress_activity" : "delete"} size={18} className={deletingId === u.id ? "animate-spin" : ""} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {visibleHistory.length === 0 && (
                    <tr>
                      <td colSpan={isManager ? 4 : 6} className="text-center py-8 text-text-muted">
                        No uploads recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-4 md:inset-x-auto md:right-8 md:bottom-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Upload received!</p>
            <p className="text-xs opacity-70">{toast}</p>
          </div>
          <button onClick={() => setToast(null)} className="btn-icon text-white/60! hover:text-white! ml-4">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Demo fallback (Supabase not configured) — unchanged from before: simulated
// parsing over localStorage, per DB_Plan.md's "keep demo-store as the
// fallback when supabaseConfigured is false."
// ─────────────────────────────────────────────────────────────────────────
function DemoUploadsClient({ user }: { user: SessionUser }) {
  const { uploads, recordGuardUpload, setUploadStatus } = useDemoStore();
  const isManager = user.role === "MANAGER";
  const [selectedCity, setSelectedCity] = useState<City>(isManager ? user.city! : "DELHI");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visibleUploads = useMemo(
    () => (isManager ? uploads.filter((u) => u.city === user.city) : uploads),
    [uploads, isManager, user.city]
  );

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayStatus = (city: City): DemoUploadStatus => {
    const todays = uploads.filter((u) => u.city === city && u.date === todayStr);
    if (todays.length === 0) return "PENDING";
    return todays[0].status;
  };

  function handleFiles(files: FileList | null) {
    setUploadError(null);
    if (!files || files.length === 0) return;
    const file = files[0];

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setUploadError("Only .xlsx files are supported.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("File exceeds the 10MB limit.");
      return;
    }

    setUploading(true);
    const id = recordGuardUpload(selectedCity, file.name, user.name);

    setTimeout(() => {
      const fakeRows = 60 + Math.floor(Math.random() * 80);
      setUploadStatus(id, "PARSED", fakeRows);
      setUploading(false);
      setToast(`"${file.name}" parsed — ${fakeRows} rows staged for ${selectedCity}.`);
      setTimeout(() => setToast(null), 5000);
    }, 1500);

    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="p-container-margin">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h2 className="font-headline text-xl text-text-primary">Upload Guard Register</h2>
          <div className="flex items-center gap-2 mt-1 text-text-muted">
            <Icon name="location_on" size={18} />
            <span className="text-sm font-medium">{selectedCity} Warehouse</span>
            <span className="mx-2 text-text-disabled">•</span>
            <span className="text-sm">
              {new Date().toLocaleDateString("en-IN", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        </div>
      </div>

      {!isManager && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          {CITIES.map((c) => {
            const status = todayStatus(c);
            return (
              <button
                key={c}
                onClick={() => setSelectedCity(c)}
                className={`card p-4 text-left transition-shadow duration-150 ${
                  selectedCity === c ? "border-accent shadow-card-hover" : "hover:border-accent/40"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-headline text-sm font-bold text-text-primary">{c}</span>
                  {selectedCity === c && (
                    <Icon name="check_circle" size={16} className="text-accent" />
                  )}
                </div>
                <span className={DEMO_STATUS_BADGE[status]}>
                  {status === "PENDING" ? "Awaiting upload" : status}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-12 gap-gutter">
        <section className="col-span-12 lg:col-span-8">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`bg-surface-card border-2 border-dashed rounded-card p-8 md:p-16 flex flex-col items-center justify-center text-center transition-colors duration-150 cursor-pointer ${
              dragOver ? "border-accent bg-surface-elevated" : "border-border hover:border-accent"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            {uploading ? (
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 border-4 border-accent-soft border-t-accent rounded-full animate-spin mb-4"></div>
                <p className="text-sm font-medium text-accent">Uploading &amp; parsing…</p>
              </div>
            ) : (
              <>
                <div className="w-20 h-20 bg-surface-elevated rounded-full flex items-center justify-center mb-6 border border-border">
                  <Icon name="cloud_upload" size={40} className="text-accent" />
                </div>
                <h3 className="font-headline text-lg text-text-primary mb-2">
                  Drag your Excel file here or click to browse
                </h3>
                <p className="text-sm text-text-muted mb-6">
                  Supports .xlsx files only. Maximum file size 10MB.
                </p>
                <button type="button" className="btn btn-secondary">
                  Browse Files
                </button>
              </>
            )}
          </div>

          {uploadError && (
            <div className="mt-4 flex items-center gap-3 p-4 bg-danger-soft rounded-card border border-danger/20">
              <Icon name="error" size={22} className="text-danger" />
              <p className="text-sm text-danger font-semibold">{uploadError}</p>
            </div>
          )}

          <div className="mt-6 flex items-start gap-3 p-4 bg-warning-soft rounded-card border border-status-warning/20">
            <Icon name="info" size={22} className="text-status-warning" />
            <div>
              <p className="text-sm text-status-warning font-semibold mb-0.5">
                Register Guidelines
              </p>
              <p className="text-sm text-text-secondary">
                Upload the daily gate entry/exit log by 10 PM. Column headers must match the
                template; item codes must exist in the master catalogue. Parsed rows feed the
                next reconciliation run.
              </p>
            </div>
          </div>
        </section>

        <section className="col-span-12 lg:col-span-4">
          <div className="card p-6 h-full">
            <h4 className="font-headline text-lg text-text-primary mb-4">Quick Insights</h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-control flex items-center justify-center text-success bg-success-soft">
                    <Icon name="fact_check" size={22} />
                  </div>
                  <span className="text-sm font-medium">Today&apos;s Status</span>
                </div>
                <span className={DEMO_STATUS_BADGE[todayStatus(selectedCity)]}>
                  {todayStatus(selectedCity)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-control flex items-center justify-center text-accent bg-accent-soft">
                    <Icon name="history" size={22} />
                  </div>
                  <span className="text-sm font-medium">Uploads Recorded</span>
                </div>
                <span className="text-sm font-bold">{visibleUploads.length}</span>
              </div>
              <div className="pt-4">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-3">
                  Validation Rules
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    .xlsx format, ≤ 10MB
                  </li>
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    Column headers must remain unchanged
                  </li>
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />
                    Date format: DD-MM-YYYY
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-12 mt-4">
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-surface-elevated">
              <h4 className="font-headline text-lg text-text-primary">
                Upload Status{isManager ? ` — ${user.city}` : " — All Cities"}
              </h4>
            </div>
            <div className="overflow-x-auto">
              <table className="table-clean">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>File Name</th>
                    {!isManager && <th>City</th>}
                    <th>Status</th>
                    <th>Rows</th>
                    <th>Uploaded By</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUploads.map((u) => (
                    <tr key={u.id}>
                      <td className="text-text-secondary">{u.date}</td>
                      <td className="font-medium text-text-primary">{u.fileName}</td>
                      {!isManager && <td>{u.city}</td>}
                      <td>
                        <span className={DEMO_STATUS_BADGE[u.status]}>{u.status}</span>
                      </td>
                      <td className="text-text-secondary">{u.rows ?? "—"}</td>
                      <td className="text-text-secondary">{u.uploadedBy}</td>
                      <td className="text-text-secondary">{u.time}</td>
                    </tr>
                  ))}
                  {visibleUploads.length === 0 && (
                    <tr>
                      <td colSpan={isManager ? 6 : 7} className="text-center py-8 text-text-muted">
                        No uploads recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-4 md:inset-x-auto md:right-8 md:bottom-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Upload successful!</p>
            <p className="text-xs opacity-70">{toast}</p>
          </div>
          <button onClick={() => setToast(null)} className="btn-icon text-white/60! hover:text-white! ml-4">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
