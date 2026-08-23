import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Field, FieldGroup, FieldLabel } from "./field";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const meta = {
  title: "Design System/Popover",
  component: Popover,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Popover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const EditMarker: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button>编辑标记</Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => event.preventDefault()}
        >
          <FieldGroup className="min-w-0 flex-1">
            <Field>
              <FieldLabel className="sr-only" htmlFor="story-marker-tags">
                编辑标记标签
              </FieldLabel>
              <Input
                id="story-marker-tags"
                defaultValue="重点, 公式"
                placeholder="输入标签，用逗号分隔"
              />
            </Field>
          </FieldGroup>
          <Button type="submit">确认</Button>
        </form>
      </PopoverContent>
    </Popover>
  ),
};
