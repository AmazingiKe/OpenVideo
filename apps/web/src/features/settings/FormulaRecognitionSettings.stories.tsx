import type { Meta, StoryObj } from "@storybook/react-vite";

import { FormulaRecognitionSettings } from "./FormulaRecognitionSettings";

const meta = {
  title: "Settings/FormulaRecognitionSettings",
  component: FormulaRecognitionSettings,
  args: {
    model: {
      name: "视频公式识别",
      description: "从关键帧提取向量、范数、分式和矩阵等结构化公式。",
      repositories: [
        "PaddlePaddle/PP-DocLayout_plus-L",
        "PaddlePaddle/PP-FormulaNet_plus-S",
      ],
      installation_status: "not_installed",
      download_job: null,
    },
    on_change: () => undefined,
  },
} satisfies Meta<typeof FormulaRecognitionSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotInstalled: Story = {};

export const Installed: Story = {
  args: {
    model: {
      ...meta.args.model,
      installation_status: "installed",
    },
  },
};
