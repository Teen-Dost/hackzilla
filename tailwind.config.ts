import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/features/**/*.{ts,tsx}",
    "./src/hooks/**/*.{ts,tsx}",
    "./src/animations/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          border: "hsl(var(--sidebar-border))",
          accent: "hsl(var(--sidebar-accent))",
        },
        glow: "hsl(var(--glow))",
      },
      borderRadius: {
        lg: "var(--radius-lg)",
        md: "var(--radius-md)",
        sm: "var(--radius-sm)",
        xl: "var(--radius-xl)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "display-xl": ["4.5rem", { lineHeight: "1.05", letterSpacing: "-0.04em", fontWeight: "600" }],
        "display-lg": ["3.5rem", { lineHeight: "1.08", letterSpacing: "-0.035em", fontWeight: "600" }],
        "display-md": ["2.5rem", { lineHeight: "1.12", letterSpacing: "-0.03em", fontWeight: "600" }],
      },
      boxShadow: {
        glow: "0 0 80px -20px hsl(var(--glow) / 0.45)",
        card: "0 0 0 1px hsl(var(--border)), 0 12px 40px -24px hsl(0 0% 0% / 0.65)",
        "card-hover": "0 0 0 1px hsl(var(--border) / 0.8), 0 20px 50px -20px hsl(var(--glow) / 0.25)",
      },
      backgroundImage: {
        "mesh-gradient":
          "radial-gradient(at 40% 20%, hsl(var(--glow) / 0.22) 0px, transparent 50%), radial-gradient(at 80% 0%, hsl(280 60% 50% / 0.12) 0px, transparent 45%), radial-gradient(at 0% 50%, hsl(200 80% 50% / 0.08) 0px, transparent 50%), linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)",
        "grid-fade":
          "linear-gradient(to bottom, hsl(var(--background)) 0%, transparent 12%, transparent 88%, hsl(var(--background)) 100%), linear-gradient(90deg, hsl(var(--border) / 0.35) 1px, transparent 1px), linear-gradient(hsl(var(--border) / 0.35) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "64px 64px",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        shimmer: "shimmer 2s infinite",
        "pulse-soft": "pulse-soft 3s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
