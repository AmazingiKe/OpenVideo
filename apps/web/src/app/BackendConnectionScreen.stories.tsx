import type { Meta, StoryObj } from "@storybook/react-vite";

import { BackendConnectionScreen } from "./BackendConnectionScreen";

const meta = {
  title: "App/BackendConnectionScreen",
  component: BackendConnectionScreen,
  args: { state: "disconnected" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BackendConnectionScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const Checking: Story = {
  args: { state: "checking" },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};
