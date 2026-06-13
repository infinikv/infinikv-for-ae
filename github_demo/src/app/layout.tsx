import "./globals.css";
import React from "react";
import Link from "next/link";
import { Inter, JetBrains_Mono } from "next/font/google";
import { HardDrive, Zap } from "lucide-react";
import HistoryWarmup from "@/components/HistoryWarmup";
import { LanguageToggle, LocalizedFooterText, LocalizedNavMenu } from "@/components/LocalizedNav";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: "InfiniKV — SSD-Backed KV Cache",
  description: "A GPU-centric two-tier HBM-SSD KV Cache service bringing GPU-initiated direct storage (GIDS) to LLM inference",
};

function LogoMark() {
  return (
    <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center shadow-sm">
      <HardDrive className="w-[18px] h-[18px] text-white" />
      <Zap className="absolute -top-1 -right-1 w-3.5 h-3.5 text-amber-400 drop-shadow" />
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={`${inter.variable} ${jetbrains.variable} font-sans min-h-screen flex flex-col bg-white text-gray-900`}>
        <nav className="border-b border-gray-200/80 bg-white/80 backdrop-blur-xl sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center space-x-8">
              <Link href="/" className="flex items-center space-x-2.5 group">
                <LogoMark />
                <span className="font-mono text-lg font-extrabold tracking-tight text-gray-900 group-hover:text-sky-600 transition-colors">
                  InfiniKV
                </span>
              </Link>
              <LocalizedNavMenu />
            </div>
            <LanguageToggle />
          </div>
        </nav>
        <HistoryWarmup />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-gray-200 py-6 mt-auto">
          <div className="max-w-7xl mx-auto px-4 text-center text-xs text-gray-400">
            <LocalizedFooterText />
          </div>
        </footer>
      </body>
    </html>
  );
}
