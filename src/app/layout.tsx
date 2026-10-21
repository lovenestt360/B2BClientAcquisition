import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Client Acquisition",
  description: "Compliance-first B2B client acquisition platform",
  applicationName: "Client Acquisition",
  appleWebApp: { capable: true, title: "Acquire", statusBarStyle: "default" },
  formatDetection: { telephone: false }, // we render phone numbers ourselves; avoid accidental auto-links
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // let the layout use the iPhone safe areas
  themeColor: "#1d4ed8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
