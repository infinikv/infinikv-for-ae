"use client";

import React from "react";
import { t, useLocale } from "@/lib/i18n";

/**
 * 顶部上下文占用进度条。
 *
 * 使用位置：每个 demo 页"参数区"上方。
 *
 * 显示规则：
 *   - 累计输入 token / 最大窗口（默认 131072 = 128K）
 *   - <45% 绿色，45~70% 琥珀，>=70% 红色（告警：逼近窗口上限）
 *   - 可同时展示 LMCache 与 InfiniKV 两组累计值（两条窄条并列）
 *   - 空状态显示 "-- / 131K"
 */
export interface ContextTokenBarProps {
  /** 当前已累计的 prompt token 数（通常是最近一轮的 actual_chat_input_tokens 或多轮累加值） */
  lmcacheTokens?: number;
  infinikvTokens?: number;
  /** 模型窗口上限，默认 llama3.1 的 128K */
  maxTokens?: number;
  /** 额外说明（如 "第 3/5 轮" / "8 路并发" / "累计 5 轮"） */
  subtitle?: string;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
}

function colorFor(pct: number): string {
  if (pct >= 70) return "bg-rose-500";
  if (pct >= 45) return "bg-amber-500";
  return "bg-emerald-500";
}

function textColorFor(pct: number): string {
  if (pct >= 70) return "text-rose-600";
  if (pct >= 45) return "text-amber-600";
  return "text-emerald-700";
}

export default function ContextTokenBar({
  lmcacheTokens,
  infinikvTokens,
  maxTokens = 131072,
  subtitle,
}: ContextTokenBarProps) {
  const [locale] = useLocale();
  const lmPct = lmcacheTokens ? Math.min(100, (lmcacheTokens / maxTokens) * 100) : 0;
  const ikPct = infinikvTokens ? Math.min(100, (infinikvTokens / maxTokens) * 100) : 0;
  const bothShown = lmcacheTokens !== undefined && infinikvTokens !== undefined;

  const renderRow = (label: string, tokens: number | undefined, pct: number, barColor: string) => (
    <div className="flex items-center space-x-3">
      <span className="text-xs font-bold text-gray-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden relative">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-mono font-bold w-32 text-right ${tokens ? textColorFor(pct) : "text-gray-400"}`}>
        {tokens ? `${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)}` : `-- / ${formatTokenCount(maxTokens)}`}
      </span>
      <span className={`text-xs font-mono font-bold w-10 text-right ${tokens ? textColorFor(pct) : "text-gray-300"}`}>
        {tokens ? `${pct.toFixed(0)}%` : "--"}
      </span>
    </div>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3.5 space-y-2 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-bold text-gray-700">{t(locale, "context.title")}</span>
          <span className="text-xs text-gray-400 font-mono">{t(locale, "context.window")}</span>
        </div>
        {subtitle && <span className="text-xs text-gray-500 font-medium">{subtitle}</span>}
      </div>
      {bothShown ? (
        <div className="space-y-1.5">
          {renderRow("LMCache-DRAM", lmcacheTokens, lmPct, colorFor(lmPct))}
          {renderRow("InfiniKV", infinikvTokens, ikPct, colorFor(ikPct))}
        </div>
      ) : (
        renderRow(t(locale, "context.cumulative"), lmcacheTokens ?? infinikvTokens, Math.max(lmPct, ikPct), colorFor(Math.max(lmPct, ikPct)))
      )}
      {(lmPct >= 70 || ikPct >= 70) && (
        <div className="text-xs text-rose-600 font-bold flex items-center space-x-1">
          <span>⚠️</span>
          <span>{t(locale, "context.warning")}</span>
        </div>
      )}
      {(lmPct >= 45 && lmPct < 70) || (ikPct >= 45 && ikPct < 70) ? (
        <div className="text-xs text-amber-600 font-medium flex items-center space-x-1">
          <span>ⓘ</span>
          <span>{t(locale, "context.notice")}</span>
        </div>
      ) : null}
    </div>
  );
}
