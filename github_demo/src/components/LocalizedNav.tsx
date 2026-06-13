"use client";

import Link from "next/link";
import { Languages } from "lucide-react";
import { t, useLocale } from "@/lib/i18n";

function NavLink({
  href,
  label,
  dot,
  hover,
}: {
  href: string;
  label: string;
  dot?: string;
  hover: string;
}) {
  return (
    <Link
      href={href}
      className={`text-gray-500 px-3 py-2 rounded-lg transition-all text-sm font-medium flex items-center space-x-1.5 ${hover}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      <span>{label}</span>
    </Link>
  );
}

export function LocalizedNavMenu() {
  const [locale] = useLocale();

  return (
    <div className="hidden md:flex items-center space-x-0.5">
      <NavLink href="/" label={t(locale, "nav.home")} hover="hover:text-gray-900 hover:bg-gray-50" />
      <NavLink
        href="/demo/drone-fleet"
        label={t(locale, "nav.multi")}
        dot="bg-sky-500"
        hover="hover:text-sky-600 hover:bg-sky-50/60"
      />
      <NavLink
        href="/demo/stress-test"
        label={t(locale, "nav.stress")}
        dot="bg-violet-500"
        hover="hover:text-violet-600 hover:bg-violet-50/60"
      />
    </div>
  );
}

export function LanguageToggle() {
  const [locale, setLocale] = useLocale();
  const nextLocale = locale === "zh" ? "en" : "zh";

  return (
    <button
      type="button"
      onClick={() => setLocale(nextLocale)}
      aria-label={t(locale, "nav.toggle")}
      title={t(locale, "nav.toggle")}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 shadow-sm transition-all hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
    >
      <Languages className="h-4 w-4" />
      <span className="font-mono">{locale === "zh" ? "EN" : "中文"}</span>
    </button>
  );
}

export function LocalizedFooterText() {
  const [locale] = useLocale();
  return <>{t(locale, "footer.text")}</>;
}
