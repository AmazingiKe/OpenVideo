import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const current_directory = path.dirname(fileURLToPath(import.meta.url));
const backend_origin = "http://127.0.0.1:38471";

export default defineConfig({
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    include: [
      "@dnd-kit/dom",
      "@dnd-kit/react",
      "@milkdown/kit/component/link-tooltip",
      "@milkdown/kit/core",
      "@milkdown/kit/preset/commonmark",
      "@milkdown/kit/preset/gfm",
      "@milkdown/kit/prose/commands",
      "@milkdown/kit/prose/schema-list",
      "@tanstack/react-virtual",
      "@viselect/react",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backend_origin,
      "/assets/media-": backend_origin,
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
