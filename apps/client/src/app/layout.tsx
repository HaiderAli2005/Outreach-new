import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { IconSprite } from "@/components/ui/Icon";
import { Providers } from "./providers";
import "./globals.css";
import "./design-v2.css";
import "./live.css";
import "./landing.css";
import "./app-ui.css";
import "./onboarding-ui.css";

export const metadata: Metadata = {
  title: { default: "Aperture · Cold email infrastructure, set up by an agent", template: "%s · Aperture" },
  description: "Aperture reads your site, finds your buyers, then sets up, warms and launches your sending domains. Your main domain never sends a cold email.",
};

export const viewport: Viewport = { themeColor: "#161615", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <IconSprite />
        <div className="grain" aria-hidden="true" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
