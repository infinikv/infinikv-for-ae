"use client";

import { useEffect } from "react";
import { getCachedLatestRecord, getHistory } from "@/lib/history";

export default function HistoryWarmup() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const scenarios = ["drone-delivery", "drone-fleet", "stress-test"] as const;
      void Promise.allSettled(
        scenarios
          .filter(scenario => !getCachedLatestRecord(scenario))
          .map(scenario => getHistory(scenario)),
      );
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
