import type { Decorator, Preview } from "@storybook/react-vite";
import { MotionConfig } from "motion/react";
import { MemoryRouter } from "react-router-dom";

import { GlobalAssistantProvider } from "../src/app/global_assistant";
import { LocalPreferencesProvider } from "../src/app/local_preferences";
import { ApplicationQueryProvider } from "../src/app/query_cache";
import "../src/styles.css";

const with_design_surface: Decorator = (Story, context) => (
  <MotionConfig reducedMotion="user">
    <LocalPreferencesProvider>
      <MemoryRouter initialEntries={[context.parameters.route ?? "/summary"]}>
        <ApplicationQueryProvider>
          <GlobalAssistantProvider>
            <div className="min-h-screen bg-background text-foreground">
              <Story />
            </div>
          </GlobalAssistantProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>
    </LocalPreferencesProvider>
  </MotionConfig>
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
