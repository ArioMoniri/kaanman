import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: "#1F2023",
        "surface-light": "#2A2A2E",
        border: "#444444",
        "border-light": "#555555",
        accent: "#6366F1",
        "accent-light": "#818CF8",
      },
    },
  },
  plugins: [],
};
export default config;
