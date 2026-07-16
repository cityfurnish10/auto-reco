import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Inter } from "next/font/google";
import "./globals.css";

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
  variable: "--font-hanken",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Cityfurnish | Operations Portal",
  description: "Warehouse Reconciliation Platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Inline, pre-hydration theme init — reads the saved preference (or system
// default) and stamps data-theme on <html> before first paint so there's no
// light->dark flash. Runs as a blocking script since it must execute before
// the body renders; suppressHydrationWarning on <html> below silences the
// expected server/client attribute mismatch this causes.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("cf-theme");
    var theme = stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${hanken.variable} ${inter.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
