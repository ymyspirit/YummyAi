import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@xyflow/react/dist/style.css";

import "./globals.css";
import "./workflow.css";

export const metadata: Metadata = {
  title: "YummyAI Research",
  description: "Versioned ecommerce research evidence library",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
