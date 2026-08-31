import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

const meta = {
  title: "Design System/Select",
  component: Select,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ConversationSelect />,
};

export const Ghost: Story = {
  render: () => <ConversationSelect ghost />,
};

function ConversationSelect({ ghost = false }: { ghost?: boolean }) {
  return (
    <Select defaultValue="perspective">
      <SelectTrigger
        variant={ghost ? "ghost" : "default"}
        aria-label="历史对话"
      >
        <SelectValue placeholder="新建对话" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectGroup>
          <SelectItem value="perspective">透视投影问答</SelectItem>
          <SelectItem value="summary">课程内容总结</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
