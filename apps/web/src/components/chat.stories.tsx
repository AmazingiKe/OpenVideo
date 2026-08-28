import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import type { ReactNode } from "react";

import { AgentComposer } from "./AgentComposer";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Message, MessageContent } from "./ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";
import { cn } from "@/lib/utils";

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
    <ChatSurface
      messages={[
        {
          id: "assistant-1",
          role: "assistant",
          content: "我可以根据时间轴证据修改当前文档。",
        },
        {
          id: "user-1",
          role: "user",
          content: "把第二节改成更精炼的步骤列表。",
        },
      ]}
    >
      <AgentComposer
        value=""
        on_change={fn()}
        on_submit={fn()}
        thinking_mode="auto"
        on_thinking_mode_change={fn()}
        thinking_modes_enabled={false}
        retrieval_scope="current_asset"
        on_retrieval_scope_change={fn()}
        library_scope_enabled={false}
        scope_pinned={false}
        on_scope_pinned_change={fn()}
        attachments={[]}
        on_remove_attachment={fn()}
      />
    </ChatSurface>
  ),
};

export const Streaming: Story = {
  args: { children: null },
  render: () => (
    <ChatSurface
      height_class="h-72"
      messages={[
        {
          id: "assistant-stream",
          role: "assistant",
          content: "正在读取相关片段并整理修改建议…",
        },
      ]}
    >
      <AgentComposer
        value="继续补充案例"
        on_change={fn()}
        on_submit={fn()}
        on_cancel={fn()}
        pending
        thinking_mode="auto"
        on_thinking_mode_change={fn()}
        thinking_modes_enabled={false}
        retrieval_scope="current_asset"
        on_retrieval_scope_change={fn()}
        library_scope_enabled={false}
        scope_pinned={false}
        on_scope_pinned_change={fn()}
        attachments={[]}
        on_remove_attachment={fn()}
      />
    </ChatSurface>
  ),
};

export const OverflowingConversation: Story = {
  args: { children: null },
  render: () => (
    <ChatSurface
      height_class="h-64"
      messages={Array.from({ length: 8 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        content: `第 ${index + 1} 条较长回复：消息保持自然高度，并由正式会话滚动组件统一管理。`,
      }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("未找到消息滚动区域");
    await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
  },
};

function ChatSurface({
  messages,
  children,
  height_class = "h-96",
}: {
  messages: {
    id: string;
    role: "user" | "assistant";
    content: string;
  }[];
  children?: ReactNode;
  height_class?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-80 flex-col overflow-hidden rounded-lg border bg-card",
        height_class,
      )}
    >
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-4">
              {messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      <Bubble
                        align={message.role === "user" ? "end" : "start"}
                        variant={message.role === "user" ? "default" : "muted"}
                      >
                        <BubbleContent>{message.content}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {children}
    </div>
  );
}
