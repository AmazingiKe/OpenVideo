import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const current_directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          setupFiles: "./src/test_setup.ts",
        },
      },
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(current_directory, ".storybook"),
          }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                channel: "chrome",
              },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
