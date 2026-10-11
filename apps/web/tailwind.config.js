
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],

  darkMode: "class",

  theme: {
    extend: {
      colors: {
        ecosphere: {
          bg: "#050505",
          sidebar: "#080908",
          card: "#0d0f0d",
          "card-hover": "#141714",
          panel: "#101210",
          border: "#252925",

          accent: "#a3e635",
          "accent-hover": "#84cc16",
          "accent-dim": "#365314",
          "accent-soft": "rgb(163 230 53 / 10%)",

          blue: "#38bdf8",
          muted: "#929992",
          text: "#f4f5f4",

          critical: "#fb5252",
          warning: "#f59e0b",
          medium: "#eab308",
          success: "#a3e635",
          info: "#38bdf8",
        },
      },

      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },

      boxShadow: {
        panel: "0 8px 28px rgb(0 0 0 / 20%)",
        glow: "0 0 18px rgb(163 230 53 / 14%)",
        "glow-strong": "0 0 24px rgb(163 230 53 / 22%)",
      },

      borderRadius: {
        panel: "12px",
      },
    },
  },

  plugins: [],
};
