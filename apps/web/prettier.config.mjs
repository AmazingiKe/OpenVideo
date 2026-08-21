/** @type {import("prettier").Config & import("prettier-plugin-tailwindcss").PluginOptions} */
const config = {
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./src/styles.css",
};

export default config;
