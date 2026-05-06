/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                background: "var(--background)",
                foreground: "var(--foreground)",
                primary: "#0EA5E9",
                secondary: "#6366F1",
                infinikv: "#0EA5E9",
                lmcache: "#F59E0B",
                card: { bg: "#F8FAFC", border: "#E2E8F0" },
                dark: {
                    DEFAULT: "#0D1117",
                    card: "#161B22",
                    surface: "#21262D",
                    border: "#30363D",
                },
            },
            fontFamily: {
                sans: ["Inter", "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Noto Sans SC"', "sans-serif"],
                mono: ["JetBrains Mono", "Fira Code", "monospace"],
            },
            animation: {
                "glow-pulse": "glow-pulse 2s ease-in-out infinite",
                "slide-up": "slide-up 0.6s ease-out",
                "fade-in": "fade-in 0.5s ease-out",
            },
            keyframes: {
                "glow-pulse": { "0%, 100%": { opacity: "0.4" }, "50%": { opacity: "1" } },
                "slide-up": { "0%": { transform: "translateY(30px)", opacity: "0" }, "100%": { transform: "translateY(0)", opacity: "1" } },
                "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
            },
        },
    },
    plugins: [],
};
