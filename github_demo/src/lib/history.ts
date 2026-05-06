"use client";

import { publicPath } from "@/lib/static-assets";

export type TestRecord = {
  id: string;
  scenario: "long-context" | "concurrent" | "agent" | "drone-delivery" | "drone-fleet" | "dispatch" | "stress-test";
  scenarioLabel: string;
  timestamp: number;
  schemaVersion?: number;
  config: Record<string, any>;
  results: Record<string, any>;
  meta?: Record<string, any>;
  normalizedReplay?: Record<string, any>;
};

const LEGACY_STORAGE_KEY = "infinikv_test_history";
const LATEST_RECORD_CACHE_KEY = "infinikv_latest_history_by_scenario_v1";

function readLegacyHistory(): TestRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readLatestRecordCache(): Record<string, TestRecord> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LATEST_RECORD_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLatestRecordCache(cache: Record<string, TestRecord>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LATEST_RECORD_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Static cache is only a convenience; ignore quota or private-mode failures.
  }
}

function rememberLatestRecords(records: TestRecord[]) {
  if (typeof window === "undefined" || records.length === 0) return;
  const cache = readLatestRecordCache();
  for (const record of records) {
    const existing = cache[record.scenario];
    if (!existing || record.timestamp > existing.timestamp) {
      cache[record.scenario] = record;
    }
  }
  writeLatestRecordCache(cache);
}

async function readStaticHistory(): Promise<TestRecord[]> {
  const res = await fetch(publicPath("/history.json"), { cache: "force-cache" });
  if (!res.ok) throw new Error("无法读取 public/history.json");
  const data = await res.json();
  const records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [];
  return records as TestRecord[];
}

export function getCachedLatestRecord(scenario: TestRecord["scenario"]): TestRecord | null {
  const cached = readLatestRecordCache()[scenario];
  if (cached) return cached;
  const legacyLatest = readLegacyHistory()
    .filter(record => record.scenario === scenario)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return legacyLatest || null;
}

export async function importLegacyHistory(records = readLegacyHistory()): Promise<{ imported: number }> {
  rememberLatestRecords(records);
  return { imported: records.length };
}

export async function getHistory(scenario?: string): Promise<TestRecord[]> {
  try {
    const all = await readStaticHistory();
    const records = scenario ? all.filter(r => r.scenario === scenario) : all;
    rememberLatestRecords(records);
    return records;
  } catch {
    const all = readLegacyHistory();
    const records = scenario ? all.filter(r => r.scenario === scenario) : all;
    rememberLatestRecords(records);
    return records;
  }
}

export async function getHistoryRecord(id: string): Promise<TestRecord | null> {
  const all = await getHistory();
  return all.find(record => record.id === id) || null;
}

export async function saveRecord(record: Omit<TestRecord, "id" | "timestamp"> & Partial<Pick<TestRecord, "id" | "timestamp">>): Promise<TestRecord> {
  const staticRecord: TestRecord = {
    id: record.id || `static_${Date.now()}`,
    timestamp: record.timestamp || Date.now(),
    schemaVersion: record.schemaVersion || 2,
    scenario: record.scenario,
    scenarioLabel: record.scenarioLabel,
    config: record.config,
    results: record.results,
    meta: record.meta,
    normalizedReplay: record.normalizedReplay,
  };
  rememberLatestRecords([staticRecord]);
  return staticRecord;
}

export async function deleteRecord(_id: string): Promise<void> {
  throw new Error("GitHub Pages 静态版不支持删除历史记录");
}

export function getLegacyHistorySnapshot(): TestRecord[] {
  return readLegacyHistory();
}
