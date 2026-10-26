import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "YT Atlas | YouTube channel analytics", template: "%s | YT Atlas" },
  description: "Privately organize YouTube channels, collect public performance metrics, and compare audience activity across India.",
  applicationName: "YT Atlas",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
