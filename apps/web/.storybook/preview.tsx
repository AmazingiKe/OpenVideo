import type { Decorator, Preview } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";

import { GlobalAssistantProvider } from "../src/app/global_assistant";
import { ApplicationQueryProvider } from "../src/app/query_cache";
import "../src/styles.css";

const with_design_surface: Decorator = (Story, context) => (
  <MemoryRouter initialEntries={[context.parameters.route ?? "/summary"]}>
    <ApplicationQueryProvider>
      <GlobalAssistantProvider>
        <div className="min-h-screen bg-background text-foreground">
          <Story />
        </div>
      </GlobalAssistantProvider>
    </ApplicationQueryProvider>
  </MemoryRouter>
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
