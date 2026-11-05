import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Inkastarna · Laget före allt",
  description:
    "Vårt lag. Våra matcher. Inkastarnas hemmaplan mellan matcherna. Innefotboll på Stora Mossen.",
  applicationName: "Inkastarna",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Inkastarna",
  },
  icons: {
    icon: [
      { url: "/icons/inkastarna-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      {
        url: "/icons/inkastarna-apple-180.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#19191e",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
