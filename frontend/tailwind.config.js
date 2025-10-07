/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1220",
        card: "#121a2b",
        text: "#e5ecf6",
        muted: "#94a3b8",
        buy: "#22c55e",
        sell: "#ef4444",
        accent: "#22d3ee"
      },
    },
  },
  plugins: [],
};
