import type { Decorator, Preview } from "@storybook/react-vite";

import "../src/styles.css";

const with_design_surface: Decorator = (Story) => (
  <div className="min-h-screen bg-background text-foreground">
    <Story />
  </div>
);

const preview: Preview = {
  decorators: [with_design_surface],
  tags: ["autodocs", "test"],
  parameters: {
    a11y: {
      test: "error",
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
