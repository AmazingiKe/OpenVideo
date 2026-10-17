import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within, waitFor } from "storybook/test";
import { TranscriptHistory } from "./TranscriptHistory";

const VERSION_ID = "transcript-version-019c0000000070008000000000000001";
const TRANSCRIPT = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  language: "zh",
  created_at: "2026-10-17T12:00:00Z",
  segments: [
    {
      start_seconds: 0,
      end_seconds: 3,
      text: "这是人工修正后保留下来的字幕，可以预览并恢复。",
      emotion: null,
      audio_events: [],
    },
  ],
};

const meta = {
  title: "Workbench/TranscriptHistory",
  component: TranscriptHistory,
  args: { asset_id: TRANSCRIPT.asset_id, on_restored: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm p-4">
        <Story />
      </div>
    ),
  ],
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = (input) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith("/versions")
            ? [
                {
                  version_id: VERSION_ID,
                  saved_at: "2026-10-17T12:00:00Z",
                  reason: "replacement",
                  segment_count: 1,
                },
              ]
            : TRANSCRIPT,
        ),
      );
    return () => {
      window.fetch = original_fetch;
    };
  },
} satisfies Meta<typeof TranscriptHistory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: "字幕历史" }));
    await userEvent.click(
      await body.findByRole("combobox", { name: "历史版本" }),
    );
    await userEvent.click(await body.findByRole("option"));
    await expect(
      await body.findByText(TRANSCRIPT.segments[0].text),
    ).toBeVisible();
  },
};

export const Restore: Story = {
  play: async (context) => {
    await Preview.play!(context);
    const body = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: "恢复此版本" }));
    await expect(
      await body.findByText("已恢复字幕，恢复前的内容也已保存在历史中。"),
    ).toBeVisible();
    await waitFor(() =>
      expect(context.args.on_restored).toHaveBeenCalledOnce(),
    );
  },
};

export const RunningTask: Story = {
  args: { disabled: true },
  play: async (context) => {
    await Preview.play!(context);
    await expect(
      within(context.canvasElement).getByRole("button", { name: "恢复此版本" }),
    ).toBeDisabled();
  },
};
