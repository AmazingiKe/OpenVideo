import eslint from "@eslint/js";
import react_hooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";
import globals from "globals";
import typescript_eslint from "typescript-eslint";

export default typescript_eslint.config(
  {
    ignores: ["dist", "storybook-static", "coverage"],
  },
  eslint.configs.recommended,
  ...typescript_eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": react_hooks,
    },
    rules: {
      ...react_hooks.configs.flat.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: [
      "src/**/use_*.{ts,tsx}",
      "src/app/asset_catalog.tsx",
      "src/app/global_assistant.tsx",
      "src/app/task_manager.tsx",
      "src/app/AppShell.tsx",
      "src/features/player/playback_session.tsx",
    ],
    rules: {
      // 项目要求 hook 使用 snake_case，与插件的 useX 命名识别规则不兼容。
      "react-hooks/rules-of-hooks": "off",
    },
  },
  ...storybook.configs["flat/recommended"],
);
