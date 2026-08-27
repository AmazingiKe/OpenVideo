import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Bubble, Message, MessageComposer, MessageScroller } from "./chat";

const meta = {
  title: "Components/Chat",
  component: MessageScroller,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageScroller>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  args: { children: null },
  render: () => (
    <div className="flex h-96 w-80 flex-col overflow-hidden rounded-lg border bg-card">
      <MessageScroller className="flex-1">
        <Message role="assistant">
          <Bubble role="assistant">我可以根据时间轴证据修改当前文档。</Bubble>
        </Message>
        <Message role="user">
          <Bubble role="user">把第二节改成更精炼的步骤列表。</Bubble>
        </Message>
      </MessageScroller>
      <MessageComposer
        value=""
        on_change={() => undefined}
        on_submit={() => undefined}
      />
    </div>
  ),
};

export const Streaming: Story = {
  args: { children: null },
  render: () => (
    <div className="flex h-72 w-80 flex-col overflow-hidden rounded-lg border bg-card">
      <MessageScroller className="flex-1">
        <Message role="assistant">
          <Bubble role="assistant">正在读取相关片段并整理修改建议…</Bubble>
        </Message>
      </MessageScroller>
      <MessageComposer
        value="继续补充案例"
        on_change={() => undefined}
        on_submit={() => undefined}
        pending
      />
    </div>
  ),
};

export const OverflowingConversation: Story = {
  args: { children: null },
  render: () => (
    <div className="flex h-64 w-80 flex-col overflow-hidden rounded-lg border bg-card">
      <MessageScroller className="flex-1">
        {Array.from({ length: 6 }, (_, index) => (
          <Message key={index} role="assistant">
            <Bubble role="assistant">
              第 {index + 1}{" "}
              条较长回复：消息保持自然高度，并由会话区域统一滚动。
            </Bubble>
          </Message>
        ))}
      </MessageScroller>
      <MessageComposer
        value=""
        on_change={() => undefined}
        on_submit={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("未找到消息滚动区域");
    await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
  },
};
