import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Client Acquisition",
    short_name: "Acquire",
    description: "Compliance-first B2B outreach: CRM, iPhone-assisted SMS and calls",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f8fafc",
    theme_color: "#1d4ed8",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
    shortcuts: [
      { name: "Today", url: "/today" },
      { name: "SMS", url: "/sms" },
      { name: "Calls", url: "/calls" },
    ],
  };
}
