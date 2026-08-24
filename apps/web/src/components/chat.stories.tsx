import type { Meta, StoryObj } from "@storybook/react-vite";

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
