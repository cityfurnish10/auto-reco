// The guard app's shell — deliberately NOT the dashboard's.
//
// Same brand and the same design tokens, but none of the dashboard's chrome:
// no sidebar, no navigation, no tables. A manager sits at a desk with two
// hands; a guard is standing outdoors holding something, using one thumb, in
// bright sun or near dark. Sharing a layout between the two would serve
// neither.
//
// Route-grouped so a guard's phone never downloads the dashboard bundle.

import type { Metadata, Viewport } from "next";
import "./gate.css";

export const metadata: Metadata = {
  title: "Gate Register",
  // Standalone so "Add to Home Screen" opens with no browser chrome at all —
  // the difference between something that feels like an app and something that
  // feels like a website a guard was told to use.
  appleWebApp: { capable: true, title: "Gate", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcf8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#14171a" },
  ],
};

export default function GateLayout({ children }: { children: React.ReactNode }) {
  return <div className="gate-root">{children}</div>;
}
