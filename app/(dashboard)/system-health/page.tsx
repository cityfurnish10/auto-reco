import { CONNECTORS, ERROR_LOGS } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

const STATUS_PILL: Record<string, string> = {
  OK: "badge badge-done",
  FAILED: "badge badge-high",
  DEGRADED: "badge badge-medium",
};

const LOG_BADGE: Record<string, string> = {
  UNRESOLVED: "badge badge-high",
  RETRYING: "badge badge-medium",
  RESOLVED: "badge badge-done",
};

export default function SystemHealthPage() {
  const anyFailed = CONNECTORS.some((c) => c.status === "FAILED");

  return (
    <div className="p-container-margin space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <h2 className="font-headline text-xl text-text-primary">
          System Health
        </h2>
        {anyFailed ? (
          <div className="flex items-center gap-2 badge badge-high">
            <span className="w-1.5 h-1.5 rounded-full bg-danger"></span>
            DEGRADED — 1 CONNECTOR FAILING
          </div>
        ) : (
          <div className="flex items-center gap-2 badge badge-done">
            <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
            ALL SYSTEMS OPERATIONAL
          </div>
        )}
        <span className="text-xs text-text-muted uppercase tracking-wider">
          Sample data — live checks arrive with the ingestion layer
        </span>
      </div>

      {/* Connector cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-gutter">
        {CONNECTORS.map((c) => (
          <div key={c.name} className="card card-hover p-5">
            <div className="flex justify-between items-start mb-4">
              <div className="p-2 bg-accent-soft rounded-control">
                <Icon name={c.icon} size={22} className="text-accent" />
              </div>
              <span className={STATUS_PILL[c.status]}>{c.status}</span>
            </div>
            <h3 className="font-headline text-base text-text-primary mb-1">{c.name}</h3>
            <p className="text-text-muted text-sm">{c.description}</p>
            <div className="mt-4 pt-4 border-t border-border flex justify-between items-center">
              <span className="text-xs opacity-60 uppercase">
                {c.status === "FAILED" ? "Last Attempt" : "Last Sync"}
              </span>
              <span
                className={`text-sm font-medium ${
                  c.status === "FAILED" ? "text-danger" : "text-text-primary"
                }`}
              >
                {c.lastSync}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Error logs */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-border bg-surface-elevated">
          <div>
            <h3 className="font-headline text-lg text-text-primary">
              Recent Error Logs
            </h3>
            <p className="text-sm text-text-muted">
              System-wide critical events and sync failures
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Source</th>
                <th>City</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_LOGS.map((log, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-text-secondary">
                    {log.timestamp}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${log.sourceColor}`}
                      ></span>
                      <span className="font-medium">{log.source}</span>
                    </div>
                  </td>
                  <td>{log.city}</td>
                  <td
                    className={`font-mono truncate max-w-md ${
                      log.status === "RESOLVED"
                        ? "text-success"
                        : log.status === "RETRYING"
                          ? "text-text-secondary"
                          : "text-danger"
                    }`}
                  >
                    {log.message}
                  </td>
                  <td>
                    <span className={LOG_BADGE[log.status]}>{log.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-3 border-t border-border bg-surface-elevated">
          <p className="text-xs text-text-muted">
            Showing {ERROR_LOGS.length} recent logs (sample)
          </p>
        </div>
      </div>

      {/* Insights row */}
      <div className="grid grid-cols-1 gap-gutter">
        <div className="card p-6 flex flex-col">
          <h4 className="font-headline text-lg mb-4 text-text-primary">
            Ingestion Schedule
          </h4>
          <div className="space-y-4 flex-1">
            <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
              <div className="flex items-center gap-3">
                <Icon name="schedule" size={22} className="text-accent" />
                <span className="text-sm font-medium">Nightly ingest + reco</span>
              </div>
              <span className="text-sm font-bold">00:30 IST</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
              <div className="flex items-center gap-3">
                <Icon name="mail" size={22} className="text-accent" />
                <span className="text-sm font-medium">Daily email digest</span>
              </div>
              <span className="text-sm font-bold">11:00 IST</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-surface-elevated rounded-control">
              <div className="flex items-center gap-3">
                <Icon name="upload_file" size={22} className="text-accent" />
                <span className="text-sm font-medium">Guard upload deadline</span>
              </div>
              <span className="text-sm font-bold">22:00 IST</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
