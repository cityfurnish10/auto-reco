import GateApp from "./scan-app";
import GateErrorBoundary from "./error-boundary";

// Never prerendered: everything depends on the device's own stored token and
// its local queue, neither of which exists at build time.
export const dynamic = "force-dynamic";

export default function GatePage() {
  // Wrapped so an unexpected throw shows a message rather than a blank page —
  // see error-boundary.tsx for why that is worth a component of its own.
  return (
    <GateErrorBoundary>
      <GateApp />
    </GateErrorBoundary>
  );
}
