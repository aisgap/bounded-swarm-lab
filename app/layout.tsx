import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bounded Swarm Lab",
  description:
    "A deterministic four-agent workspace with visible limits, handoffs, and receipts.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
