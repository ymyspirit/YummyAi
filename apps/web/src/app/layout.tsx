import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@xyflow/react/dist/style.css";

import "./globals.css";
import "./workflow.css";
import "./erp-theme.css";
import { ERP_APPEARANCE_BOOTSTRAP } from "../features/navigation/appearance-preferences";

export const metadata: Metadata = {
  title: "YummyAI 电商与生产工作台",
  description: "Amazon 与 Etsy 的研究、商品、设计和订单生产工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: ERP_APPEARANCE_BOOTSTRAP }} /></head>
      <body>{children}</body>
    </html>
  );
}
