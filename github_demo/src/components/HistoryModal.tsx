"use client";

import React, { useEffect, useState } from "react";
import { X, Trash2, Clock, ChevronDown } from "lucide-react";
import { getHistory, deleteRecord, type TestRecord } from "@/lib/history";
import { t, useLocale, type Locale } from "@/lib/i18n";

const SCENARIO_LABEL_KEYS: Record<string, Parameters<typeof t>[1]> = {
  "long-context": "scenario.longContext",
  "concurrent": "scenario.concurrent",
  "agent": "scenario.agent",
  "drone-delivery": "scenario.droneDelivery",
  "drone-fleet": "scenario.droneFleet",
  "dispatch": "scenario.dispatch",
  "stress-test": "scenario.stress",
};

const SCENARIO_COLORS: Record<string, string> = {
  "long-context": "bg-sky-100 text-sky-700",
  "concurrent": "bg-amber-100 text-amber-700",
  "agent": "bg-purple-100 text-purple-700",
  "drone-delivery": "bg-emerald-100 text-emerald-700",
  "drone-fleet": "bg-rose-100 text-rose-700",
  "dispatch": "bg-indigo-100 text-indigo-700",
  "stress-test": "bg-rose-100 text-rose-700",
};

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RecordSummary({ record, locale }: { record: TestRecord; locale: Locale }) {
  const cfg = record.config || {};
  const items: string[] = [];
  if (cfg.totalRounds) items.push(locale === "zh" ? `${cfg.totalRounds}轮` : `${cfg.totalRounds} rounds`);
  if (cfg.batchCount) items.push(locale === "zh" ? `${cfg.batchCount}批` : `${cfg.batchCount} batches`);
  if (cfg.docCount) items.push(locale === "zh" ? `${cfg.docCount}文档` : `${cfg.docCount} docs`);
  if (cfg.contextBucket) items.push(`${Math.round(cfg.contextBucket / 1000)}k`);
  if (cfg.prefixReuseRate) items.push(locale === "zh" ? `复用${cfg.prefixReuseRate}%` : `${cfg.prefixReuseRate}% reuse`);
  if (cfg.concurrentCount) items.push(locale === "zh" ? `${cfg.concurrentCount}路并发` : `${cfg.concurrentCount} concurrent`);
  if (cfg.concurrentPerRound) items.push(locale === "zh" ? `${cfg.concurrentPerRound}路/轮` : `${cfg.concurrentPerRound}/round`);
  if (cfg.outputLen) items.push(locale === "zh" ? `输出${cfg.outputLen}` : `output ${cfg.outputLen}`);
  return <span className="text-xs text-gray-400">{items.join(" / ")}</span>;
}

export default function HistoryModal({
  open,
  onClose,
  currentScenario,
  onLoadRecord,
  onNavigateAndLoad,
}: {
  open: boolean;
  onClose: () => void;
  currentScenario?: string;
  onLoadRecord?: (record: TestRecord) => void;
  onNavigateAndLoad?: (record: TestRecord) => void;
}) {
  const [records, setRecords] = useState<TestRecord[]>([]);
  const [filter, setFilter] = useState<string>(currentScenario || "all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [locale] = useLocale();

  const loadRecords = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      setRecords(await getHistory());
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const snapshot = records;
    setErrorMessage("");
    setDeletingIds(prev => ({ ...prev, [id]: true }));
    setRecords(prev => prev.filter(r => r.id !== id));
    try {
      await deleteRecord(id);
      void loadRecords({ silent: true });
    } catch (err: any) {
      setRecords(snapshot);
      setErrorMessage(err?.message || "删除失败，请稍后重试");
    } finally {
      setDeletingIds(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  useEffect(() => {
    if (open) {
      setFilter(currentScenario || "all");
      setErrorMessage("");
      void loadRecords();
    }
  }, [open, currentScenario]);

  if (!open) return null;

  const filtered = filter === "all" ? records : records.filter(r => r.scenario === filter);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <Clock className="w-5 h-5 text-gray-400" />
            <h2 className="text-xl font-black text-gray-900 tracking-tight">{t(locale, "history.title")}</h2>
            <span className="text-sm text-gray-400 font-mono">{filtered.length} {t(locale, "history.count")}</span>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Filter */}
        <div className="px-6 py-3 border-b border-gray-100 flex items-center space-x-2">
          {[
            { key: "all", label: t(locale, "history.all") },
            { key: "drone-delivery", label: t(locale, "history.long") },
            { key: "drone-fleet", label: t(locale, "history.multi") },
            { key: "stress-test", label: t(locale, "history.stress") },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${filter === f.key ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Records */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
              {errorMessage}
            </div>
          )}
          {loading && (
            <div className="text-center py-6 text-sm text-gray-400">{t(locale, "history.loading")}</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-16 text-gray-400">
              <Clock className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-base font-medium">{t(locale, "history.empty.title")}</p>
              <p className="text-sm mt-1">{t(locale, "history.empty.desc")}</p>
            </div>
          )}

          {filtered.map(record => {
            const isExpanded = expandedId === record.id;
            const isCurrentScenario = record.scenario === currentScenario;
            const isDeleting = !!deletingIds[record.id];

            return (
              <div key={record.id} className={`border border-gray-200 rounded-xl overflow-hidden ${isDeleting ? "opacity-60" : ""}`}>
                {/* Record header */}
                <div className="px-4 py-3 flex items-center justify-between hover:bg-gray-50/50">
                  <div className="flex items-center space-x-3 flex-1 min-w-0">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${SCENARIO_COLORS[record.scenario] || "bg-gray-100 text-gray-600"}`}>
                      {SCENARIO_LABEL_KEYS[record.scenario] ? t(locale, SCENARIO_LABEL_KEYS[record.scenario]) : record.scenario}
                    </span>
                    <span className="text-sm text-gray-500 font-mono">{formatTime(record.timestamp)}</span>
                    <RecordSummary record={record} locale={locale} />
                  </div>
                  <div className="flex items-center space-x-1">
                    {isCurrentScenario && onLoadRecord && (
                      <button
                        onClick={() => { onLoadRecord(record); onClose(); }}
                        disabled={isDeleting}
                        className="px-3 py-1 rounded-lg bg-sky-50 text-sky-600 text-xs font-bold hover:bg-sky-100 transition-colors whitespace-nowrap"
                      >
                        {t(locale, "history.load")}
                      </button>
                    )}
                    {!isCurrentScenario && onNavigateAndLoad && (
                      <button
                        onClick={() => { onNavigateAndLoad(record); onClose(); }}
                        disabled={isDeleting}
                        className="px-3 py-1 rounded-lg bg-gray-100 text-gray-600 text-xs font-bold hover:bg-gray-200 transition-colors whitespace-nowrap"
                      >
                        {t(locale, "history.navigate")}
                      </button>
                    )}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : record.id)}
                      disabled={isDeleting}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-400"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                    <button
                      onClick={() => handleDelete(record.id)}
                      disabled={isDeleting}
                      className="p-2 hover:bg-red-50 rounded-lg transition-colors text-gray-300 hover:text-red-500 disabled:opacity-60 disabled:cursor-not-allowed"
                      title={isDeleting ? t(locale, "history.deleting") : t(locale, "history.delete")}
                    >
                      <Trash2 className={`w-4 h-4 ${isDeleting ? "animate-pulse" : ""}`} />
                    </button>
                    {isDeleting && (
                      <span className="text-xs font-semibold text-red-500">{t(locale, "history.deleting")}</span>
                    )}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/50">
                    <pre className="text-xs text-gray-600 font-mono overflow-auto max-h-[300px] whitespace-pre-wrap">
                      {JSON.stringify(record.results, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
