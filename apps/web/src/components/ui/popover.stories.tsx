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

export const EditSegment: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button>编辑片段</Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => event.preventDefault()}
        >
          <FieldGroup className="min-w-0 flex-1">
            <Field>
              <FieldLabel className="sr-only" htmlFor="story-segment-name">
                编辑片段名称
              </FieldLabel>
              <Input
                id="story-segment-name"
                defaultValue="矩阵推导"
                placeholder="输入片段名称"
              />
            </Field>
          </FieldGroup>
          <Button type="submit">确认</Button>
        </form>
      </PopoverContent>
    </Popover>
  ),
};
