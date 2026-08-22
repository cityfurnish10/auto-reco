import GateApp from "./scan-app";

// Never prerendered: everything here depends on the device's own stored token
// and its local queue, neither of which exists at build time.
export const dynamic = "force-dynamic";

export default function GatePage() {
  return <GateApp />;
}
