import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-manrope)", "system-ui", "sans-serif"],
      },
      colors: {
        surface: "rgba(255,255,255,0.04)",
        "surface-light": "rgba(255,255,255,0.07)",
        border: "rgba(255,255,255,0.10)",
        "border-light": "rgba(255,255,255,0.18)",
        accent: "#6366F1",
        "accent-light": "#818CF8",
      },
      backdropBlur: {
        glass: "20px",
        "glass-heavy": "40px",
      },
    },
  },
  plugins: [],
};
export default config;
