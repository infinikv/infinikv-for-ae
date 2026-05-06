"use client";

import React from "react";
import { X, Zap } from "lucide-react";
import { useLocale } from "@/lib/i18n";

type Scenario = "long-context" | "concurrent" | "agent" | "drone-delivery" | "drone-fleet" | "dispatch" | "stress-test";

const WORKLOAD_INFO: Record<Scenario, { title: string; color: string; sections: { label: string; content: string }[] }> = {
  "long-context": {
    title: "长上下文多轮对话 — 负载解析",
    color: "sky",
    sections: [
      {
        label: "负载特征",
        content: "上传一份企业技术文档（白皮书、合同、年报等，32k–128k tokens），对其进行 5 轮逐步深入的分析问答：从概括主题 → 提取数据 → 分析方案 → 对比观点 → 给出行动建议。每轮复用大比例的上下文前缀（由「前缀复用率」控制），仅替换末尾的问题与少量可变段落。这模拟了企业用户对高价值长文档进行深度分析的真实场景。",
      },
      {
        label: "与 KV Cache 的关系",
        content: "多轮对话中前缀固定不变，LLM 推理引擎可以将这部分的 KV Cache 缓存下来，后续轮次直接复用而无需重新计算。复用率越高，缓存命中的比例越大，首字延迟（TTFT）显著降低。第 1 轮为冷启动（无缓存），后续轮次为热启动（缓存命中），可以观察 TTFT 逐轮下降的趋势。",
      },
      {
        label: "为什么 SSD 能接近 DRAM 性能",
        content: "InfiniKV 将 KV Cache 从 GPU 显存/主机 DRAM 卸载到 SSD。长上下文场景下 KV Cache 体积很大（128k 上下文可达数 GB），DRAM 容量有限且成本高昂。InfiniKV 利用 NVMe SSD 的高带宽顺序读取和智能预取策略，在 KV Cache 加载回 GPU 时实现接近 DRAM 的吞吐，同时成本仅为 DRAM 的 1/10。",
      },
      {
        label: "对比意义",
        content: "对比 LMCache-DRAM（纯内存缓存）与 InfiniKV（SSD 缓存），观察两者在缓存命中后的 TTFT 差距。如果 InfiniKV 能在热启动轮次达到与 DRAM 接近的延迟，则证明 SSD 卸载方案是可行的低成本替代。",
      },
    ],
  },
  "concurrent": {
    title: "多用户并发压测 — 负载解析",
    color: "amber",
    sections: [
      {
        label: "负载特征",
        content: "模拟 N 个不同角色的企业用户（产品经理、数据分析师、技术架构师、CTO 等）同时查询同一份长文档。所有用户共享相同的文档前缀（KV Cache 复用），但每人提出不同的专业问题。这些请求通过 Promise.all 并行发送，真实还原企业内部知识库的多租户查询场景。",
      },
      {
        label: "与 KV Cache 的关系",
        content: "多个用户共享同一文档前缀，因此前缀部分的 KV Cache 会被频繁加载和复用。并发越高，同一时刻需要从缓存中读取的 KV Cache 数据越多，对缓存系统的带宽和 IOPS 要求越高。在 DRAM 方案中，高并发可能导致内存带宽饱和或容量不足（尤其是 128k 长上下文）；而 SSD 方案的大容量优势在此场景下更加明显。",
      },
      {
        label: "为什么 SSD 能接近 DRAM 性能",
        content: "并发场景下 KV Cache 需要频繁从存储加载到 GPU。InfiniKV 通过 NVMe SSD 的高 IOPS（数十万次/秒）和批量预取机制，即使在高并发下也能保持稳定的 KV Cache 加载吞吐。同时 SSD 的大容量（TB 级）避免了 DRAM 容量不足时的缓存驱逐问题。",
      },
      {
        label: "关键指标",
        content: "P95 尾延迟（P95 TTFT）反映高并发下最慢 5% 请求的延迟，是衡量系统稳定性的关键指标。如果 P95 延迟显著高于平均值，说明存在「长尾」问题。QPS（每秒查询数）的上界反映系统的扩展能力。ITL（Token 间延迟）反映流式输出的流畅度。",
      },
    ],
  },
  "agent": {
    title: "Agent 长上下文推理 — 负载解析",
    color: "purple",
    sections: [
      {
        label: "负载特征",
        content: "模拟企业竞品技术调研场景，将调研任务拆解为 5 个步骤：全局理解 → 架构拆解 → 数据提取 → 优劣势评估 → 决策摘要。每个步骤的输出追加到上下文中作为下一步输入，前缀复用率固定 90%。这模拟了 AI Agent 的典型企业工作流——上传一份竞品论文或白皮书，Agent 自动完成从理解到决策建议的全流程。",
      },
      {
        label: "与 KV Cache 的关系",
        content: "Agent 模式下，每一步都在前一步的基础上追加少量新内容，KV Cache 增量式累积。第 1 步为冷启动，之后每步的缓存命中率逐渐升高（因为 90% 的上下文已被缓存）。这体现了增量缓存的核心价值——随着对话推进，缓存的收益越来越大。多批次调用也意味着 KV Cache 会被反复读取和更新。",
      },
      {
        label: "为什么 SSD 能接近 DRAM 性能",
        content: "Agent 的多批次调用模式下，KV Cache 持续增长且需要长期保留。DRAM 容量有限，当 Cache 超出内存容量时会触发驱逐，导致后续步骤需要重新计算被驱逐的部分，性能急剧下降。InfiniKV 的 SSD 大容量可以完整保留所有历史 KV Cache，避免驱逐导致的性能抖动。",
      },
      {
        label: "对比意义",
        content: "观察 TTFT 随步骤推进的变化趋势。理想情况下，InfiniKV 的 TTFT 应保持稳定甚至逐步下降（缓存命中率提升），而纯 DRAM 方案可能因容量压力导致延迟波动。累计 TTFT 反映 Agent 完成整个任务链的端到端速度。",
      },
    ],
  },
  "drone-delivery": {
    title: "单节点长上下文规划 — 负载解析",
    color: "emerald",
    sections: [
      {
        label: "业务故事",
        content: "把 LLM 放在单个城市配送调度节点上：它需要读入城市规则、禁飞区、仓库与客户位置，也可以附加不同城市或不同业务场景的长文本资料。调度员每一轮提出新的配送约束，例如雨天、低空、医疗应急或商圈拥堵，模型在同一任务上下文中持续修订航线。这不是一次性问答，而是典型的长上下文、多轮规划对话。",
      },
      {
        label: "KV Cache 压力",
        content: "系统提示词、城市资料、历史航线和前几轮策略解释构成稳定前缀；每轮真正变化的只是末尾的新约束。随着轮次增加，KV Cache 不断累积，后续请求如果能复用历史前缀，就可以避免重复 prefill，TTFT 会明显降低。这个场景用一个节点把长上下文和多轮对话的基本压力讲清楚。",
      },
      {
        label: "DRAM 基线的问题",
        content: "LMCache-DRAM 在工作集较小时可以很好地承接缓存复用；但当城市资料更长、轮次更多、会话来回切换时，DRAM 容量会先成为约束。一旦旧的 KV Cache 被淘汰，后续回访就需要重新计算长前缀，TTFT 变高且波动增大。",
      },
      {
        label: "观察指标",
        content: "重点看平均 TTFT、累计 TTFT、估算 QPS 和各轮 TTFT 曲线。若 InfiniKV (SSD) 在后续轮次保持更低、更稳定的 TTFT，说明 SSD 层不仅能容纳更大的历史 KV Cache，也能把长上下文多轮规划的交互延迟压下来。",
      },
    ],
  },
  "drone-fleet": {
    title: "多节点并发规划 — 负载解析",
    color: "rose",
    sections: [
      {
        label: "业务故事",
        content: "从单个调度节点扩展到多个节点同时工作：多架无人机或多个规划服务并发读取同一批城市规则、地图约束和业务资料，但各自处理不同客户、不同机体档案和不同配送目标。共享前缀仍然存在，独立会话也同时增加，系统开始面对真实的并发工作集。",
      },
      {
        label: "KV Cache 压力",
        content: "并发节点会把单节点的 KV Cache 压力成倍放大：共享城市前缀需要被多路请求同时读取，每个节点又有自己的可变档案和输出历史。并发数、批次数和会话副本数越高，DRAM 中需要保留的活跃 KV Cache 工作集越大。",
      },
      {
        label: "DRAM 基线的问题",
        content: "如果只依赖 DRAM，KV Cache 会更早被卸载或淘汰；被淘汰的节点下一次回访时需要重新 prefill，平均 TTFT、尾延迟和吞吐都会受影响。这个问题在单节点中已经存在，在多节点并发下会进一步加剧。",
      },
      {
        label: "观察指标",
        content: "重点看平均 TTFT、估算 QPS、批次完成情况和不同并发规模下的稳定性。InfiniKV 通过 SSD 保留更多 KV Cache，目标是在节点数和批次数升高后仍保持更平稳的首字延迟，并让吞吐随并发更可控地扩展。",
      },
    ],
  },
  "stress-test": {
    title: "多轮稳态压力测试 — 负载解析",
    color: "rose",
    sections: [
      {
        label: "业务故事",
        content: "前两个负载分别说明单节点长上下文和多节点并发；压力测试则把时间维度拉长。系统持续轮换访问多份文档或会话，跑 50、100 甚至更多轮，让缓存系统从预热阶段进入稳定运行阶段。",
      },
      {
        label: "KV Cache 压力",
        content: "每轮只访问工作集中的一部分会话，但长时间运行后所有会话都会被反复回访。工作集总 KV Cache 超过 DRAM 能容纳的范围时，DRAM 基线会发生 LRU 淘汰；InfiniKV 则希望把被挤出的 KV Cache 保留在 SSD 层，后续回访时直接召回。",
      },
      {
        label: "为什么看稳态窗口",
        content: "全局平均会混合冷启动、预热和真正进入压力后的阶段，容易掩盖后半程差异。因此页面同时展示 1..N 轮全局指标和最近 20 轮稳态窗口。特别是跑到 50 轮以后，最近 20 轮更能反映系统长期服务时的真实表现。",
      },
      {
        label: "观察指标",
        content: "重点看最近 20 轮平均 TTFT、峰值 TTFT、估算 QPS，以及 GPU prefix hit、DRAM KV Cache hit 和 InfiniKV SSD hit 的变化。SSD Hit 开始上升，说明被 DRAM 淘汰的 KV Cache 正在由 SSD 层接住；若 TTFT 同时保持稳定，就能说明 InfiniKV 对稳态长跑负载的价值。",
      },
    ],
  },
  "dispatch": {
    title: "调度中心规划系统 — 负载解析",
    color: "indigo",
    sections: [
      {
        label: "负载特征",
        content: "模拟城市物流指挥中心：24 架无人机部署在 6 个区域。LLM 作为调度决策系统，接收策略类指令（响应优先/最快响应/最低成本/最大覆盖/高热区倾斜）和事件类指令（区域热度上升/天气恶化/仓库告急/活动高峰），在保留历史部署的基础上持续更新方案。支持 1/2/4 位指挥员并发视角——每次下达指令时所有激活的指挥员同时发起请求。",
      },
      {
        label: "为什么是 KV Cache 的教科书场景",
        content: "这个场景同时满足四个 KV Cache 价值维度：(1) 大前缀——基础上下文（区域定义、型号、规则）约 600+ tokens，所有轮次和所有指挥员共享；(2) 单 session 多轮增长——每轮把上轮方案追加进上下文，逐轮累积至 10k+ tokens；(3) 多 session 并发——多位指挥员同时查询，共享 prefix 被并发读取；(4) 历史持续累积——事件按钮可无限追加，历史永不重置。这四个属性叠加后，DRAM 缓存容量与带宽极易成为瓶颈。",
      },
      {
        label: "为什么 SSD 能接近 DRAM 性能",
        content: "多指挥员 × 多轮 × 大前缀的叠加负载下，总缓存占用很容易突破 DRAM 容量，触发驱逐后次轮 TTFT 会剧烈波动。InfiniKV 的 TB 级 SSD 容量确保所有历史方案、所有指挥员、所有事件的 KV Cache 都能完整保留；NVMe 的高 IOPS 在多 session 并发读取共享 prefix 时保持吞吐稳定。相同负载 DRAM 会出现长尾抖动，InfiniKV 保持平稳。",
      },
      {
        label: "观察重点",
        content: "(1) 单指挥员多轮 TTFT 趋势：上下文增长时 LMCache 是否上升、InfiniKV 是否平稳；(2) 切换并发指挥员数（1→2→4）时 P95 TTFT 的变化；(3) 连续追加事件按钮时，上下文 token 数与 TTFT 的关系曲线；(4) 区域网格中部署方案随事件的变化是否合理——这反映 LLM 在超长上下文下的理解能力（冷启动与缓存命中的质量差异）。",
      },
    ],
  },
};

const WORKLOAD_INFO_EN: Partial<Record<Scenario, { title: string; color: string; sections: { label: string; content: string }[] }>> = {
  "drone-delivery": {
    title: "Single-Node Long-Context Planning — Workload Details",
    color: "emerald",
    sections: [
      {
        label: "Business Story",
        content: "The LLM acts as one city delivery dispatch node. It reads city rules, no-fly zones, warehouse and customer locations, and can attach long documents from different cities or business settings. Each round introduces a new constraint, such as rain, low-altitude routing, medical emergency, or congestion, and the model revises the route inside the same task context. This is not a one-shot Q&A; it is a long-context, multi-round planning dialogue.",
      },
      {
        label: "KV Cache Pressure",
        content: "The system prompt, city documents, previous routes, and earlier strategy explanations form a stable prefix. Only the latest constraint changes at the tail of the prompt. As rounds accumulate, KV Cache grows. If later requests can reuse the historical prefix, repeated prefill is avoided and TTFT drops. This scenario uses one node to make the long-context and multi-round pressure easy to understand.",
      },
      {
        label: "DRAM Baseline Limitation",
        content: "LMCache-DRAM works well while the working set is small. When city documents become longer, rounds increase, or sessions are revisited, DRAM capacity becomes the first constraint. Once old KV Cache is evicted, a later revisit must recompute the long prefix, increasing TTFT and variance.",
      },
      {
        label: "What To Observe",
        content: "Focus on average TTFT, cumulative TTFT, estimated QPS, and the per-round TTFT curve. If InfiniKV (SSD) keeps TTFT lower and more stable in later rounds, it shows that the SSD tier can hold more historical KV Cache and reduce interaction latency for long-context planning.",
      },
    ],
  },
  "drone-fleet": {
    title: "Multi-Node Concurrent Planning — Workload Details",
    color: "rose",
    sections: [
      {
        label: "Business Story",
        content: "The workload scales from one dispatch node to multiple nodes running at the same time. Drones or planning services concurrently read the same city rules, map constraints, and business documents, while each node handles different customers, drone profiles, and delivery goals. Shared prefixes still exist, but independent sessions also grow, exposing the system to a realistic concurrent working set.",
      },
      {
        label: "KV Cache Pressure",
        content: "Concurrent nodes multiply the KV Cache pressure of a single node. The shared city prefix must be read by multiple requests at once, and each node also carries its own variable profile and output history. Higher concurrency, more batches, and more session replicas all increase the active KV Cache working set that DRAM must retain.",
      },
      {
        label: "DRAM Baseline Limitation",
        content: "With DRAM only, KV Cache is offloaded or evicted earlier. When an evicted node is revisited, it must prefill again, hurting average TTFT, tail latency, and throughput. This issue already exists in the single-node case and becomes more severe under multi-node concurrency.",
      },
      {
        label: "What To Observe",
        content: "Focus on average TTFT, estimated QPS, batch completion, and stability under different concurrency levels. InfiniKV keeps more KV Cache through SSD, aiming to preserve stable TTFT as node count and batch count rise.",
      },
    ],
  },
  "stress-test": {
    title: "Multi-Round Steady-State Stress Test — Workload Details",
    color: "rose",
    sections: [
      {
        label: "Business Story",
        content: "The first two workloads explain single-node long context and multi-node concurrency. This stress test stretches the time dimension: the system repeatedly rotates across multiple long-document sessions for 50, 100, or more rounds so the cache system moves from warm-up into steady-state service.",
      },
      {
        label: "KV Cache Pressure",
        content: "Each round touches only part of the working set, but all sessions are revisited over a long run. When the total KV Cache working set exceeds what DRAM can hold, the DRAM baseline performs LRU eviction. InfiniKV aims to keep evicted KV Cache in the SSD tier and recall it directly on later revisits.",
      },
      {
        label: "Why The Steady-State Window Matters",
        content: "A global average mixes cold start, warm-up, and the true pressure phase, which can hide late-run differences. The page therefore reports both 1..N global metrics and the latest 20-round steady-state window. After 50+ rounds, the latest 20 rounds better represent long-running service.",
      },
      {
        label: "What To Observe",
        content: "Focus on latest-20-round average TTFT, peak TTFT, estimated QPS, GPU prefix hit, DRAM KV Cache hit, and InfiniKV SSD hit. Rising SSD Hit means KV Cache evicted from DRAM is being caught by the SSD tier; stable TTFT at the same time demonstrates InfiniKV's value for long-running workloads.",
      },
    ],
  },
};

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; labelBg: string }> = {
  sky: { bg: "bg-sky-50/50", border: "border-sky-200", text: "text-sky-700", labelBg: "bg-sky-100" },
  amber: { bg: "bg-amber-50/50", border: "border-amber-200", text: "text-amber-700", labelBg: "bg-amber-100" },
  purple: { bg: "bg-purple-50/50", border: "border-purple-200", text: "text-purple-700", labelBg: "bg-purple-100" },
  emerald: { bg: "bg-emerald-50/50", border: "border-emerald-200", text: "text-emerald-700", labelBg: "bg-emerald-100" },
  teal: { bg: "bg-teal-50/50", border: "border-teal-200", text: "text-teal-700", labelBg: "bg-teal-100" },
  rose: { bg: "bg-rose-50/50", border: "border-rose-200", text: "text-rose-700", labelBg: "bg-rose-100" },
  indigo: { bg: "bg-indigo-50/50", border: "border-indigo-200", text: "text-indigo-700", labelBg: "bg-indigo-100" },
};

export default function WorkloadInfoModal({
  open,
  onClose,
  scenario,
}: {
  open: boolean;
  onClose: () => void;
  scenario: Scenario;
}) {
  const [locale] = useLocale();
  if (!open) return null;

  const info = locale === "en" ? (WORKLOAD_INFO_EN[scenario] ?? WORKLOAD_INFO[scenario]) : WORKLOAD_INFO[scenario];
  const colors = COLOR_MAP[info.color];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col mx-4">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <Zap className={`w-5 h-5 ${colors.text}`} />
            <h2 className="text-xl font-black text-gray-900 tracking-tight">{info.title}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {info.sections.map((section, i) => (
            <div key={i} className={`${colors.bg} border ${colors.border} rounded-xl p-5`}>
              <div className={`inline-block text-xs font-bold px-2.5 py-1 rounded-md ${colors.labelBg} ${colors.text} mb-3`}>
                {section.label}
              </div>
              <p className="text-sm text-gray-600 leading-relaxed">{section.content}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
