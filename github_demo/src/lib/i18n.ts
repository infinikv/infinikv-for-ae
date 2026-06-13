"use client";

import { useEffect, useState } from "react";

export type Locale = "zh" | "en";

export const LOCALE_STORAGE_KEY = "infinikv_locale";
export const LOCALE_EVENT = "infinikv_locale_change";

const dictionaries = {
  zh: {
    "nav.home": "首页",
    "nav.single": "单节点长上下文规划",
    "nav.multi": "无人机航线规划",
    "nav.stress": "Agent 上下文恢复",
    "nav.toggle": "切换为英文",
    "footer.text": "© 2026 InfiniKV 研发团队 — SSD-Backed KV Cache Made Practical",

    "home.badge": "GPU 直接发起的存储访问 (GIDS) 赋能 KV Cache",
    "home.subtitle": "SSD 赋能的实用级 KV Cache",
    "home.desc.a": "首个 GPU 中心化的两层（HBM-SSD）KV Cache 服务：将 GIDS 引入 KV Cache，实现",
    "home.desc.latency": "媲美 DRAM 的延迟",
    "home.desc.capacity": "近乎无限的容量",
    "home.desc.cost": "百分之一的存储成本",
    "home.cta.start": "开始在线演示",
    "home.cta.scenarios": "查看测试场景",
    "home.stat.ttft": "首字延迟降低 (vs GDS)",
    "home.stat.hit": "SSD 层缓存命中率",
    "home.stat.cost": "单节点 KV 缓存扩展容量",
    "home.stat.bandwidth": "KV Cache 读取带宽",
    "home.tech.title": "三大核心技术创新",
    "home.tech.subtitle": "让 SSD 支撑的 KV Cache 真正可用于生产环境",
    "home.tech.gpu.title": "GPU 原生 KV Cache 存储",
    "home.tech.gpu.desc": "基于对象语义的抽象层解耦 GPU 显存布局与文件布局；Tensor-Stripe 策略按 KV 张量原生粒度映射；I/O 控制开销从 O(layer x blocks) 降至 O(layer)。",
    "home.tech.uring.title": "GPU-IO Uring 异步框架",
    "home.tech.uring.desc": "零拷贝环形缓冲区 + SM 分区实现计算/IO 隔离；批量 IOCB 提交支持数千并发 GPU I/O 请求；类似 Linux io_uring 的异步完成通知。",
    "home.tech.scheduler.title": "Slack-Aware I/O 调度器",
    "home.tech.scheduler.desc": "离线分析每层 SM 空闲窗口；读写解耦调度消除 60% 带宽争用；将零气泡区间扩展至 98.3% 缓存命中率。",
    "home.scenarios.title": "在线性能对比场景",
    "home.scenarios.subtitle": "实时对比 InfiniKV (SSD) 与 LMCache-DRAM 在真实负载下的表现",
    "home.scenario.01": "场景 01",
    "home.scenario.02": "场景 02",
    "home.scenario.03": "场景 03",
    "home.scenario.single": "单节点长上下文规划",
    "home.scenario.multi": "多无人机并发航线规划",
    "home.scenario.stress": "Agent 编程上下文恢复",
    "home.storage.title": "存储层级架构",
    "home.storage.note.a": "InfiniKV 将 SSD 作为 GPU HBM 的",
    "home.storage.note.b": "透明扩展",
    "home.storage.note.c": "，通过 GIDS 完全绕过 CPU",
    "home.compare.ssd.1": "GPU 直接发起 I/O，零 CPU 开销",
    "home.compare.ssd.2": "14+ TB 容量，缓存命中率 84-86%",
    "home.compare.ssd.3": "读取带宽 25.9 GB/s，首字延迟媲美 DRAM",
    "home.compare.ssd.4": "存储成本仅 $0.000082/GB/小时",
    "home.compare.ssd.5": "640K 前缀长度下无 OOM 风险",
    "home.compare.dram.1": "CPU 驱动数据通路，需要内存拷贝",
    "home.compare.dram.2": "256 GB 容量，缓存命中率仅 24-53%",
    "home.compare.dram.3": "DRAM 带宽约 50 GB/s，额外开销低于 5%",
    "home.compare.dram.4": "内存成本 $0.0088/GB/小时（SSD 的 100 倍）",
    "home.compare.dram.5": "512K+ 前缀长度存在 OOM 风险",
    "home.compare.summary.a": "InfiniKV 实现了与 DRAM 驻留 KV Cache ",
    "home.compare.summary.latency": "相当的延迟性能",
    "home.compare.summary.b": "，同时提供",
    "home.compare.summary.capacity": "近乎无限的容量",
    "home.compare.summary.c": "，成本仅为 DRAM 的",
    "home.compare.summary.cost": "百分之一",

    "context.title": "上下文占用",
    "context.window": "llama3.1-8b-instruct · 128K 窗口",
    "context.cumulative": "累计输入",
    "context.warning": "已进入高压长上下文区间，历史 KV Cache 淘汰会显著放大后续请求的 TTFT。",
    "context.notice": "已进入长上下文压力区间；重复预填充成本升高，更容易体现 KV Cache 保留能力。",

    "history.title": "测试历史",
    "history.count": "条记录",
    "history.all": "全部",
    "history.long": "长上下文",
    "history.multi": "多节点",
    "history.stress": "Agent 重访",
    "history.loading": "历史记录加载中...",
    "history.empty.title": "暂无测试记录",
    "history.empty.desc": "运行基准测试后，结果将自动保存到此处",
    "history.load": "加载此实验记录",
    "history.navigate": "跳转并加载",
    "history.deleting": "删除中...",
    "history.delete": "删除此记录",
    "scenario.longContext": "长上下文多轮对话",
    "scenario.concurrent": "多用户并发压测",
    "scenario.agent": "Agent 长上下文推理",
    "scenario.droneDelivery": "单节点长上下文规划",
    "scenario.droneFleet": "多无人机并发航线规划",
    "scenario.dispatch": "调度中心规划系统",
    "scenario.stress": "Agent 编程上下文恢复",
    "demo.common.model": "模型",
    "demo.common.info": "负载解析",
    "demo.common.history": "测试历史",
    "demo.single.badge": "场景 01",
    "demo.single.tagline": "单节点长上下文规划 · 多轮配送策略",
    "demo.single.title": "单节点长上下文规划",
    "demo.single.description.a": "本场景用",
    "demo.single.description.node": "一个调度节点",
    "demo.single.description.b": "讲清长上下文多轮规划：系统读入城市规则、禁飞区、仓库与客户位置，也可以附加",
    "demo.single.description.docs": "不同城市或业务场景的长文本资料",
    "demo.single.description.c": "；调度员逐轮提出雨天、低空、医疗应急等新约束，模型在同一上下文中持续修订航线。历史前缀越长，",
    "demo.single.description.cache": "KV Cache 复用价值",
    "demo.single.description.d": "越高；",
    "demo.single.description.ssd": "InfiniKV 通过 SSD 保留更多历史 KV Cache",
    "demo.single.description.e": "，使后续轮次的首字延迟更稳定。",
    "demo.single.workload": "单节点长上下文负载",
    "demo.multi.badge": "场景 01",
    "demo.multi.tagline": "多无人机并发航线规划 · 并发越多，需要保留的 KV Cache 越多",
    "demo.multi.title": "多无人机并发航线规划",
    "demo.multi.description.nodes": "随着低空经济兴起，配送、巡检与救援等场景中的多个无人机节点",
    "demo.multi.description.a": "会同时发起航线规划请求：它们共享城市地图、调度规则与禁飞区等长上下文前缀，又各自保存机体状态、客户目标与历史轨迹。多机多任务的多轮并发推理，会让 ",
    "demo.multi.description.cache": "KV Cache 需求",
    "demo.multi.description.b": "成倍增加；",
    "demo.multi.description.dram": "DRAM 容量不足、历史 KV 被淘汰",
    "demo.multi.description.c": "时，节点重访需要重新预填充上下文，",
    "demo.multi.description.ssd": "InfiniKV 通过 SSD 层保留更多历史 KV Cache",
    "demo.multi.description.d": "，减少重复预填充，让首字延迟与吞吐更稳定。",
    "demo.multi.workload": "多无人机并发航线规划负载",
    "demo.stress.badge": "场景 02",
    "demo.stress.tagline": "历史任务重访 · 上下文恢复 · 多层缓存命中",
    "demo.stress.title": "Agent 编程上下文恢复",
    "demo.stress.description.a": "Agent 编程常需要",
    "demo.stress.description.time": "反复重访历史任务",
    "demo.stress.description.b": "：在多个长上下文会话之间来回切换、持续追问与修改，关注",
    "demo.stress.description.window": "历史上下文的恢复速度",
    "demo.stress.description.c": "。一旦历史 KV Cache 被淘汰，恢复上下文就要重新预填充大量代码、日志与对话；",
    "demo.stress.description.dram": "DRAM 容量有限，重访命中率低、TTFT 抬升",
    "demo.stress.description.d": "；",
    "demo.stress.description.ssd": "InfiniKV 用更大的 SSD 保存并复用历史 KV",
    "demo.stress.description.e": "，显著降低重访等待时间。",
    "demo.stress.workload": "Agent 上下文恢复负载",
  },
  en: {
    "nav.home": "Home",
    "nav.single": "Single-Node Planning",
    "nav.multi": "Drone Route Planning",
    "nav.stress": "Agent Context Recovery",
    "nav.toggle": "Switch to Chinese",
    "footer.text": "© 2026 InfiniKV Research Team — SSD-Backed KV Cache Made Practical",

    "home.badge": "GPU-Initiated Direct Storage (GIDS) for KV Cache",
    "home.subtitle": "Practical KV Cache Powered by SSD",
    "home.desc.a": "A GPU-centric two-tier HBM-SSD KV Cache service that brings GIDS into LLM inference, delivering ",
    "home.desc.latency": "DRAM-like latency",
    "home.desc.capacity": "near-unbounded capacity",
    "home.desc.cost": "storage cost at roughly one percent of DRAM",
    "home.cta.start": "Start Live Demo",
    "home.cta.scenarios": "View Workloads",
    "home.stat.ttft": "Lower TTFT (vs GDS)",
    "home.stat.hit": "SSD-tier cache hit rate",
    "home.stat.cost": "Single-node KV cache capacity",
    "home.stat.bandwidth": "KV Cache Read Bandwidth",
    "home.tech.title": "Three Core Technical Ideas",
    "home.tech.subtitle": "Making SSD-backed KV Cache practical for production inference",
    "home.tech.gpu.title": "GPU-Native KV Cache Storage",
    "home.tech.gpu.desc": "An object-semantic abstraction decouples GPU memory layout from file layout. Tensor-Stripe maps KV tensors at their native granularity, reducing I/O control overhead from O(layer x blocks) to O(layer).",
    "home.tech.uring.title": "GPU-IO Uring Async Framework",
    "home.tech.uring.desc": "Zero-copy ring buffers and SM partitioning isolate compute from I/O. Batched IOCB submission supports thousands of concurrent GPU I/O requests with io_uring-like completion notification.",
    "home.tech.scheduler.title": "Slack-Aware I/O Scheduler",
    "home.tech.scheduler.desc": "Offline analysis finds idle SM windows per layer. Decoupled read/write scheduling removes 60% of bandwidth contention and extends the zero-bubble region to a 98.3% cache hit rate.",
    "home.scenarios.title": "Live Performance Workloads",
    "home.scenarios.subtitle": "Compare InfiniKV (SSD) and LMCache-DRAM under realistic long-context workloads",
    "home.scenario.01": "Scenario 01",
    "home.scenario.02": "Scenario 02",
    "home.scenario.03": "Scenario 03",
    "home.scenario.single": "Single-Node Long-Context Planning",
    "home.scenario.multi": "Multi-Drone Concurrent Route Planning",
    "home.scenario.stress": "Agent Coding Context Recovery",
    "home.storage.title": "Storage Tiering Architecture",
    "home.storage.note.a": "InfiniKV uses SSD as a ",
    "home.storage.note.b": "transparent extension",
    "home.storage.note.c": " of GPU HBM and bypasses CPU via GIDS",
    "home.compare.ssd.1": "GPU-initiated I/O with zero CPU overhead",
    "home.compare.ssd.2": "14+ TB capacity with 84-86% cache hit rate",
    "home.compare.ssd.3": "25.9 GB/s read bandwidth with DRAM-like TTFT",
    "home.compare.ssd.4": "Storage cost only $0.000082/GB/hour",
    "home.compare.ssd.5": "No OOM risk at 640K prefix length",
    "home.compare.dram.1": "CPU-driven data path with memory copies",
    "home.compare.dram.2": "256 GB capacity and only 24-53% cache hit rate",
    "home.compare.dram.3": "About 50 GB/s DRAM bandwidth with below 5% overhead",
    "home.compare.dram.4": "Memory cost is $0.0088/GB/hour, about 100x SSD",
    "home.compare.dram.5": "OOM risk beyond 512K prefix length",
    "home.compare.summary.a": "InfiniKV achieves ",
    "home.compare.summary.latency": "latency comparable to DRAM-resident KV Cache",
    "home.compare.summary.b": ", while providing ",
    "home.compare.summary.capacity": "near-unbounded capacity",
    "home.compare.summary.c": " at only ",
    "home.compare.summary.cost": "one percent",

    "context.title": "Context Usage",
    "context.window": "llama3.1-8b-instruct · 128K window",
    "context.cumulative": "Cumulative Input",
    "context.warning": "High-pressure long-context region: evicting historical KV Cache can significantly amplify TTFT on later requests.",
    "context.notice": "Long-context pressure is visible; repeated prefill cost is rising, making KV Cache retention easier to observe.",

    "history.title": "Test History",
    "history.count": "records",
    "history.all": "All",
    "history.long": "Long Context",
    "history.multi": "Multi-Node",
    "history.stress": "Agent Revisit",
    "history.loading": "Loading history...",
    "history.empty.title": "No test records yet",
    "history.empty.desc": "Benchmark results will be saved here after a run.",
    "history.load": "Load This Record",
    "history.navigate": "Open and Load",
    "history.deleting": "Deleting...",
    "history.delete": "Delete this record",
    "scenario.longContext": "Long-Context Multi-Round Dialogue",
    "scenario.concurrent": "Concurrent User Stress Test",
    "scenario.agent": "Agent Long-Context Reasoning",
    "scenario.droneDelivery": "Single-Node Long-Context Planning",
    "scenario.droneFleet": "Multi-Drone Concurrent Route Planning",
    "scenario.dispatch": "Dispatch Center Planning System",
    "scenario.stress": "Agent Coding Context Recovery",
    "demo.common.model": "Model",
    "demo.common.info": "Workload Details",
    "demo.common.history": "Test History",
    "demo.single.badge": "Scenario 01",
    "demo.single.tagline": "Single-node long-context planning · multi-round delivery strategy",
    "demo.single.title": "Single-Node Long-Context Planning",
    "demo.single.description.a": "This workload uses ",
    "demo.single.description.node": "one dispatch node",
    "demo.single.description.b": " to explain long-context multi-round planning. The system reads city rules, no-fly zones, warehouse and customer locations, and can also attach ",
    "demo.single.description.docs": "long documents from different cities or business settings",
    "demo.single.description.c": ". The dispatcher adds new constraints round by round, such as rain, low-altitude rules, medical emergency, or congestion, and the model revises the route in the same context. The longer the historical prefix, the higher the ",
    "demo.single.description.cache": "KV Cache reuse value",
    "demo.single.description.d": "; ",
    "demo.single.description.ssd": "InfiniKV keeps more historical KV Cache on SSD",
    "demo.single.description.e": ", making TTFT more stable in later rounds.",
    "demo.single.workload": "Single-Node Long-Context Workload",
    "demo.multi.badge": "Scenario 01",
    "demo.multi.tagline": "Multi-drone concurrent route planning · more drones mean more KV Cache to keep",
    "demo.multi.title": "Multi-Drone Concurrent Route Planning",
    "demo.multi.description.nodes": "As the low-altitude economy grows, multiple planning nodes across delivery, inspection, and rescue",
    "demo.multi.description.a": " issue route-planning requests at the same time. They share long prefixes such as the city map, dispatch rules, and no-fly zones, while each node carries its own drone profile, customer target, and flight history. Multi-drone, multi-round concurrent inference multiplies the single-node ",
    "demo.multi.description.cache": "KV Cache demand",
    "demo.multi.description.b": "; when ",
    "demo.multi.description.dram": "DRAM runs short and historical KV is evicted",
    "demo.multi.description.c": ", revisiting a node has to prefill its context again, so ",
    "demo.multi.description.ssd": "InfiniKV retains more historical KV Cache on the SSD tier",
    "demo.multi.description.d": ", cutting repeated prefill and keeping TTFT and throughput more stable.",
    "demo.multi.workload": "Multi-Drone Concurrent Route-Planning Workload",
    "demo.stress.badge": "Scenario 02",
    "demo.stress.tagline": "Historical task revisits · context recovery · multi-tier cache hits",
    "demo.stress.title": "Agent Coding Context Recovery",
    "demo.stress.description.a": "Agent coding often needs to ",
    "demo.stress.description.time": "revisit past tasks again and again",
    "demo.stress.description.b": ": switching back and forth across long-context sessions to keep asking and editing — what matters is ",
    "demo.stress.description.window": "how fast the historical context recovers",
    "demo.stress.description.c": ". Once historical KV Cache is evicted, recovering context means re-prefilling large amounts of code, logs and dialogue; ",
    "demo.stress.description.dram": "DRAM has limited capacity, so hit rate is low and TTFT rises on revisits",
    "demo.stress.description.d": "; ",
    "demo.stress.description.ssd": "InfiniKV uses a larger SSD to keep and reuse historical KV",
    "demo.stress.description.e": ", sharply cutting revisit wait time.",
    "demo.stress.workload": "Agent Context Recovery Workload",
  },
} as const;

type TranslationKey = keyof typeof dictionaries.zh;

function normalizeLocale(value: string | null | undefined): Locale {
  return value === "en" ? "en" : "zh";
}

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") return "zh";
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return stored ? normalizeLocale(stored) : "zh";
}

export function setStoredLocale(locale: Locale) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: locale }));
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    const initial = getStoredLocale();
    setLocaleState(initial);
    document.documentElement.lang = initial === "zh" ? "zh-CN" : "en";

    const onLocaleChange = (event: Event) => {
      const next = normalizeLocale((event as CustomEvent<Locale>).detail);
      setLocaleState(next);
      document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    };

    window.addEventListener(LOCALE_EVENT, onLocaleChange);
    return () => window.removeEventListener(LOCALE_EVENT, onLocaleChange);
  }, []);

  return [locale, setStoredLocale];
}

export function t(locale: Locale, key: TranslationKey): string {
  return dictionaries[locale][key] ?? dictionaries.zh[key] ?? key;
}
