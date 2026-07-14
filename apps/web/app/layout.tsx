import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BookReviewEditor · 图书出版前协同审校平台",
  description: "主编、文学经纪人、AI 智能助手与审校员协同的书稿审校与修订管理平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
