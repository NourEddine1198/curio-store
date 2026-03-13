import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Curio brand colors (from packaging)
        goul: {
          red: "#DC2626",      // Goul Bla Matgoul accent
          blue: "#2563EB",     // Goul Bla Matgoul secondary
        },
        roubla: {
          yellow: "#EAB308",   // Roubla accent
          dark: "#171717",     // Roubla background
        },
      },
    },
  },
  plugins: [],
};
export default config;
