import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { MarkdownEditor } from "./MarkdownEditor";

const MARKDOWN = `# 所见即所得编辑

正文包含行内公式 \\(E = mc^2\\)，也支持独立公式：

\\[
A = \\pi r^2
\\]

## 任务与表格

- [x] 检查公式
- [ ] 完成复盘

| 功能 | 状态 |
| --- | --- |
| 数学公式 | 可编辑 |
| 文档大纲 | 已同步 |

## Mermaid

\`\`\`mermaid
graph LR
  Markdown --> 预览
  预览 --> 编辑
\`\`\`

脚注示例。[^note]

[^note]: 脚注内容可继续编辑。
`;

function MarkdownEditorFixture() {
  const [markdown, set_markdown] = useState(MARKDOWN);
  return (
    <div className="flex h-[760px] min-w-0 bg-background text-foreground">
      <MarkdownEditor
        document_key="storybook-markdown-editor"
        markdown={markdown}
        on_change={set_markdown}
        on_selection_change={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: "Summary/MarkdownEditor",
  component: MarkdownEditorFixture,
  tags: ["!test"],
} satisfies Meta<typeof MarkdownEditorFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
