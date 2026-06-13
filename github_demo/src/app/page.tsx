"use client";

import Link from "next/link";
import { ArrowRight, Zap, Layers, Server, Activity, HardDrive } from "lucide-react";
import { motion } from "framer-motion";
import { t, useLocale } from "@/lib/i18n";

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.15, duration: 0.6 },
  }),
};

function StatNumber({
  value,
  unit,
  label,
}: {
  value: string;
  unit: string;
  label: string;
}) {
  const displayValue = value.replace(/-/g, "–");
  const unitText = unit === "×" || unit === "%" ? unit : ` ${unit}`;

  return (
    <div className="group relative overflow-hidden rounded-3xl border border-slate-200/80 bg-white/90 px-4 py-7 text-center shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-all duration-300 hover:-translate-y-1 hover:border-slate-300 hover:shadow-[0_18px_45px_rgba(15,23,42,0.10)]">
      <div className="flex min-h-[72px] items-center justify-center">
        <span className="whitespace-nowrap font-sans text-[36px] font-black leading-none tracking-[-0.06em] text-slate-900 sm:text-[42px] md:text-[40px] lg:text-[46px] xl:text-[50px]">
          {displayValue}
          <span>{unitText}</span>
        </span>
      </div>

      <div className="mx-auto mt-4 flex min-h-[42px] max-w-[180px] items-center justify-center text-sm font-semibold leading-snug tracking-wide text-slate-500 sm:text-[15px]">
        {label}
      </div>
    </div>
  );
}

function TechCard({
  icon: Icon,
  title,
  desc,
  iconColor,
  iconBg,
}: {
  icon: any;
  title: string;
  desc: string;
  iconColor: string;
  iconBg: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-8 card-hover group shadow-sm">
      <div className={`w-12 h-12 rounded-xl ${iconBg} flex items-center justify-center mb-5`}>
        <Icon className={`w-6 h-6 ${iconColor}`} />
      </div>
      <h3 className="text-gray-900 font-bold text-xl mb-3 tracking-tight">{title}</h3>
      <p className="text-gray-500 text-[15px] leading-relaxed">{desc}</p>
    </div>
  );
}

function ScenarioCard({
  href,
  title,
  accent,
  tag,
}: {
  href: string;
  title: string;
  accent: string;
  tag: string;
}) {
  return (
    <Link href={href} className="block group h-full">
      <div className="h-full min-h-[120px] bg-white border border-gray-200 rounded-2xl p-4 card-hover relative overflow-hidden shadow-sm flex flex-col">
        <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${accent}`} />
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-500">
            {tag}
          </span>
          <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-gray-600 group-hover:translate-x-1 transition-all" />
        </div>
        <h3 className="text-gray-900 font-bold text-base tracking-tight leading-snug">{title}</h3>
      </div>
    </Link>
  );
}

export default function Home() {
  const [locale] = useLocale();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);

  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-slate-50 via-sky-50/30 to-white">
        <div className="absolute top-20 left-1/4 w-[500px] h-[500px] bg-sky-100/50 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute top-40 right-1/4 w-[400px] h-[400px] bg-indigo-100/40 rounded-full blur-[100px] pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-24 text-center relative z-10">
          <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
            <div className="inline-flex items-center space-x-2.5 bg-white/80 backdrop-blur border border-gray-200/80 px-6 py-2.5 rounded-full mb-10 shadow-sm">
              <div className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-glow-pulse" />
              <span className="text-base font-semibold text-gray-700 tracking-wide">
                {tr("home.badge")}
              </span>
            </div>
          </motion.div>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={fadeUp}
            custom={1}
            className="flex items-center justify-center space-x-5 mb-8"
          >
            <div className="relative w-16 h-16 sm:w-[72px] sm:h-[72px] rounded-2xl bg-gradient-to-br from-sky-400 via-indigo-500 to-purple-600 flex items-center justify-center shadow-xl shadow-sky-300/40 flex-shrink-0">
              <HardDrive className="w-8 h-8 sm:w-9 sm:h-9 text-white drop-shadow-lg" />
              <Zap className="absolute -top-1.5 -right-1.5 w-5 h-5 text-amber-300 drop-shadow-lg" />
            </div>
            <h1 className="text-6xl sm:text-7xl md:text-8xl font-black tracking-tight">
              <span className="gradient-text-hero" style={{ paddingRight: "0.05em" }}>
                InfiniKV
              </span>
            </h1>
          </motion.div>

          <motion.p
            initial="hidden"
            animate="visible"
            variants={fadeUp}
            custom={2}
            className="text-2xl sm:text-3xl text-gray-700 font-semibold max-w-3xl mx-auto mb-5 tracking-tight"
          >
            {tr("home.subtitle")}
          </motion.p>

          <motion.p
            initial="hidden"
            animate="visible"
            variants={fadeUp}
            custom={3}
            className="text-lg text-gray-500 max-w-2xl mx-auto mb-14 leading-relaxed"
          >
            {tr("home.desc.a")}
            <span className="text-sky-600 font-semibold">{tr("home.desc.latency")}</span>、
            <span className="text-sky-600 font-semibold">{tr("home.desc.capacity")}</span>、
            {locale === "zh" ? "以及" : "and "}
            <span className="text-amber-600 font-semibold">{tr("home.desc.cost")}</span>。
          </motion.p>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={fadeUp}
            custom={4}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <Link
              href="/demo/drone-fleet"
              className="flex items-center px-10 py-3.5 rounded-xl text-white bg-sky-500 hover:bg-sky-600 font-bold text-base transition-all hover:shadow-xl hover:shadow-sky-200/50 active:scale-[0.98]"
            >
              {tr("home.cta.start")} <ArrowRight className="ml-2 w-5 h-5" />
            </Link>
            <Link
              href="#scenarios"
              className="flex items-center px-10 py-3.5 rounded-xl text-gray-700 bg-white border border-gray-300 hover:border-gray-400 font-semibold text-base transition-all hover:shadow-md"
            >
              {tr("home.cta.scenarios")}
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Key Numbers */}
      <section className="border-y border-slate-100 bg-gradient-to-b from-slate-50/90 via-white to-white py-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-6 lg:gap-8">
            <StatNumber value="2-3.5" unit="×" label={tr("home.stat.ttft")} />
            <StatNumber value="84-86" unit="%" label={tr("home.stat.hit")} />
            <StatNumber value="14+" unit="TB" label={tr("home.stat.cost")} />
            <StatNumber value="25.9" unit="GB/s" label={tr("home.stat.bandwidth")} />
          </div>
        </div>
      </section>

      {/* Core Tech */}
      <section className="max-w-6xl mx-auto px-4 py-24">
        <div className="text-center mb-14">
          <h2 className="text-4xl font-black text-gray-900 mb-4 tracking-tight">
            {tr("home.tech.title")}
          </h2>
          <p className="text-lg text-gray-500">{tr("home.tech.subtitle")}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <TechCard
            icon={HardDrive}
            title={tr("home.tech.gpu.title")}
            desc={tr("home.tech.gpu.desc")}
            iconColor="text-sky-600"
            iconBg="bg-sky-100"
          />
          <TechCard
            icon={Layers}
            title={tr("home.tech.uring.title")}
            desc={tr("home.tech.uring.desc")}
            iconColor="text-indigo-600"
            iconBg="bg-indigo-100"
          />
          <TechCard
            icon={Activity}
            title={tr("home.tech.scheduler.title")}
            desc={tr("home.tech.scheduler.desc")}
            iconColor="text-purple-600"
            iconBg="bg-purple-100"
          />
        </div>
      </section>

      {/* Scenarios */}
      <section id="scenarios" className="max-w-6xl mx-auto px-4 pb-24">
        <div className="text-center mb-14">
          <h2 className="text-4xl font-black text-gray-900 mb-4 tracking-tight">
            {tr("home.scenarios.title")}
          </h2>
          <p className="text-lg text-gray-500">{tr("home.scenarios.subtitle")}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
          {/* <ScenarioCard href="/demo/long-context" tag="场景 01"
            title="长上下文多轮对话负载"
            accent="from-sky-400 to-blue-500" />
          <ScenarioCard href="/demo/concurrent" tag="场景 02"
            title="多用户并发负载测试"
            accent="from-amber-400 to-orange-500" />
          <ScenarioCard href="/demo/agent" tag="场景 03"
            title="Agent 长上下文推理负载"
            accent="from-purple-400 to-pink-500" /> */}
          <ScenarioCard
            href="/demo/drone-fleet"
            tag={tr("home.scenario.01")}
            title={tr("home.scenario.multi")}
            accent="from-sky-400 to-blue-500"
          />

          <ScenarioCard
            href="/demo/stress-test"
            tag={tr("home.scenario.02")}
            title={tr("home.scenario.stress")}
            accent="from-violet-400 to-purple-500"
          />

          {/* <ScenarioCard href="/demo/dispatch" tag="场景 06"
            title="调度中心规划系统"
            accent="from-indigo-400 to-purple-500" />
             */}
        </div>
      </section>

      {/* Storage Tier */}
      <section className="max-w-6xl mx-auto px-4 pb-24">
        <div className="bg-gradient-to-br from-gray-50 to-slate-50 border border-gray-200 rounded-3xl p-8 md:p-14">
          <h2 className="text-3xl font-black text-gray-900 mb-10 text-center tracking-tight">
            {tr("home.storage.title")}
          </h2>

          <div className="space-y-4 max-w-xl mx-auto">
            {[
              {
                label: "GPU HBM",
                bw: "2-4 TB/s",
                cap: "80 GB",
                cost: "$$$$$",
                color: "bg-purple-500",
                width: "w-full",
              },
              {
                label: "CPU DRAM",
                bw: "50 GB/s",
                cap: "512 GB",
                cost: "$$$",
                color: "bg-amber-500",
                width: "w-5/6",
              },
              {
                label: "NVMe SSD (InfiniKV)",
                bw: "25.9 GB/s",
                cap: "14+ TB",
                cost: "$",
                color: "bg-sky-500",
                width: "w-4/6",
              },
            ].map((tier, i) => (
              <div key={i} className="flex items-center space-x-4">
                <div
                  className={`${tier.width} ${tier.color} rounded-xl px-5 py-4 flex items-center justify-between shadow-sm`}
                >
                  <span className="text-white text-base font-bold">{tier.label}</span>
                  <span className="text-white/80 text-sm font-mono font-medium">{tier.bw}</span>
                </div>

                <div className="text-right text-sm text-gray-500 whitespace-nowrap">
                  <div className="font-mono font-semibold">{tier.cap}</div>
                  <div className="text-xs mt-0.5">{tier.cost}</div>
                </div>
              </div>
            ))}

            <div className="text-center pt-4">
              <p className="text-sm text-gray-500">
                {tr("home.storage.note.a")}
                <span className="text-sky-600 font-medium">{tr("home.storage.note.b")}</span>
                {tr("home.storage.note.c")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="max-w-6xl mx-auto px-4 pb-24">
        <div className="bg-white border border-gray-200 rounded-3xl overflow-hidden shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="p-10 border-b md:border-b-0 md:border-r border-gray-200">
              <div className="flex items-center space-x-3 mb-7">
                <div className="w-3.5 h-3.5 rounded-full bg-sky-500" />
                <h3 className="text-xl font-bold text-sky-600">InfiniKV (SSD)</h3>
              </div>

              <ul className="space-y-4 text-[15px] text-gray-600">
                <li className="flex items-start space-x-3">
                  <Zap className="w-5 h-5 text-sky-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.ssd.1")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Zap className="w-5 h-5 text-sky-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.ssd.2")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Zap className="w-5 h-5 text-sky-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.ssd.3")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Zap className="w-5 h-5 text-sky-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.ssd.4")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Zap className="w-5 h-5 text-sky-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.ssd.5")}</span>
                </li>
              </ul>
            </div>

            <div className="p-10">
              <div className="flex items-center space-x-3 mb-7">
                <div className="w-3.5 h-3.5 rounded-full bg-amber-500" />
                <h3 className="text-xl font-bold text-amber-600">LMCache-DRAM</h3>
              </div>

              <ul className="space-y-4 text-[15px] text-gray-600">
                <li className="flex items-start space-x-3">
                  <Server className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.dram.1")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Server className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.dram.2")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Server className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.dram.3")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Server className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.dram.4")}</span>
                </li>
                <li className="flex items-start space-x-3">
                  <Server className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>{tr("home.compare.dram.5")}</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-200 bg-gradient-to-r from-gray-50 to-slate-50 px-10 py-5 text-center">
            <p className="text-base text-gray-500 leading-relaxed">
              {tr("home.compare.summary.a")}
              <span className="text-sky-600 font-semibold">
                {tr("home.compare.summary.latency")}
              </span>
              {tr("home.compare.summary.b")}
              <span className="text-sky-600 font-semibold">
                {tr("home.compare.summary.capacity")}
              </span>
              {tr("home.compare.summary.c")}
              <span className="text-amber-600 font-semibold">
                {tr("home.compare.summary.cost")}
              </span>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}