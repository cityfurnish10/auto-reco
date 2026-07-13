"use client";

import { useMemo, useRef, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import type { SessionUser } from "@/lib/demo-auth";
import { CITIES, type City, type UploadStatus } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

const STATUS_BADGE: Record<UploadStatus, string> = {
  PENDING: "badge badge-medium",
  UPLOADED: "badge badge-info",
  PARSED: "badge badge-done",
  ERROR: "badge badge-high",
};

const MAX_SIZE_MB = 10;

export default function UploadsClient({ user }: { user: SessionUser }) {
  const { uploads, recordGuardUpload, setUploadStatus } = useDemoStore();
  const isManager = user.role === "MANAGER";
  const [selectedCity, setSelectedCity] = useState<City>(
    isManager ? user.city! : "DELHI"
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visibleUploads = useMemo(
    () =>
      isManager ? uploads.filter((u) => u.city === user.city) : uploads,
    [uploads, isManager, user.city]
  );

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayStatus = (city: City): UploadStatus => {
    const todays = uploads.filter(
      (u) => u.city === city && u.date === todayStr
    );
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
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setUploadError(`File exceeds the ${MAX_SIZE_MB}MB limit.`);
      return;
    }

    setUploading(true);
    const id = recordGuardUpload(selectedCity, file.name, user.name);

    // Demo mode: simulate server-side parsing. Real parsing (exceljs +
    // Supabase Storage) lands with the Phase 2 ingestion layer.
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
      {/* Header */}
      <div className="flex justify-between items-end mb-8">
        <div>
          <h2 className="font-headline text-xl text-text-primary">
            Upload Guard Register
          </h2>
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

      {/* Admin: city status tabs */}
      {!isManager && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          {CITIES.map((c) => {
            const status = todayStatus(c);
            return (
              <button
                key={c}
                onClick={() => setSelectedCity(c)}
                className={`card p-4 text-left transition-shadow duration-150 ${
                  selectedCity === c
                    ? "border-accent shadow-card-hover"
                    : "hover:border-accent/40"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-headline text-sm font-bold text-text-primary">
                    {c}
                  </span>
                  {selectedCity === c && (
                    <Icon name="check_circle" size={16} className="text-accent" />
                  )}
                </div>
                <span className={STATUS_BADGE[status]}>
                  {status === "PENDING" ? "Awaiting upload" : status}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-12 gap-gutter">
        {/* Drop zone */}
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
            className={`bg-surface-card border-2 border-dashed rounded-card p-16 flex flex-col items-center justify-center text-center transition-colors duration-150 cursor-pointer ${
              dragOver
                ? "border-accent bg-surface-elevated"
                : "border-border hover:border-accent"
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
                <p className="text-sm font-medium text-accent">
                  Uploading &amp; parsing…
                </p>
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
                  Supports .xlsx files only. Maximum file size {MAX_SIZE_MB}MB.
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
              <p className="text-sm text-danger font-semibold">
                {uploadError}
              </p>
            </div>
          )}

          <div className="mt-6 flex items-start gap-3 p-4 bg-warning-soft rounded-card border border-status-warning/20">
            <Icon name="info" size={22} className="text-status-warning" />

            <div>
              <p className="text-sm text-status-warning font-semibold mb-0.5">
                Register Guidelines
              </p>
              <p className="text-sm text-text-secondary">
                Upload the daily gate entry/exit log by 10 PM. Column headers
                must match the template; item codes must exist in the master
                catalogue. Parsed rows feed the next reconciliation run.
              </p>
            </div>
          </div>
        </section>

        {/* Quick insights */}
        <section className="col-span-12 lg:col-span-4">
          <div className="card p-6 h-full">
            <h4 className="font-headline text-lg text-text-primary mb-4">
              Quick Insights
            </h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-control flex items-center justify-center text-success bg-success-soft">
                    <Icon name="fact_check" size={22} />
                  </div>
                  <span className="text-sm font-medium">Today&apos;s Status</span>
                </div>
                <span className={STATUS_BADGE[todayStatus(selectedCity)]}>
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
                <span className="text-sm font-bold">
                  {visibleUploads.length}
                </span>
              </div>
              <div className="pt-4">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-3">
                  Validation Rules
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-sm">
                    <Icon name="check_circle" size={16} className="text-success" />

                    .xlsx format, ≤ {MAX_SIZE_MB}MB
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

        {/* Upload history */}
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
                      <td className="font-medium text-text-primary">
                        {u.fileName}
                      </td>
                      {!isManager && <td>{u.city}</td>}
                      <td>
                        <span className={STATUS_BADGE[u.status]}>
                          {u.status}
                        </span>
                      </td>
                      <td className="text-text-secondary">
                        {u.rows ?? "—"}
                      </td>
                      <td className="text-text-secondary">
                        {u.uploadedBy}
                      </td>
                      <td className="text-text-secondary">{u.time}</td>
                    </tr>
                  ))}
                  {visibleUploads.length === 0 && (
                    <tr>
                      <td
                        colSpan={isManager ? 6 : 7}
                        className="text-center py-8 text-text-muted"
                      >
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

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-8 right-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Upload successful!</p>
            <p className="text-xs opacity-70">{toast}</p>
          </div>
          <button
            onClick={() => setToast(null)}
            className="btn-icon text-white/60! hover:text-white! ml-4"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
