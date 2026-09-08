import { useCallback, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TASK_CENTER_TRIGGER_ID,
  TaskSubmissionFeedback,
} from "./TaskSubmissionFeedback";

const meta = {
  title: "Feedback/TaskSubmissionFeedback",
  component: TaskSubmissionFeedback,
  args: { origin: { x: 0, y: 0 }, on_complete: () => undefined },
  render: function SubmissionExample() {
    const [origin, set_origin] = useState<{ x: number; y: number } | null>(
      null,
    );
    const finish = useCallback(() => set_origin(null), []);
    return (
      <div className="flex min-h-96 flex-col justify-between p-8">
        <Button
          id={TASK_CENTER_TRIGGER_ID}
          className="self-end"
          variant="ghost"
          size="icon"
          aria-label="任务中心"
        >
          <ListTodo />
        </Button>
        <Button
          className="self-start"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            set_origin({
              x: bounds.x + bounds.width / 2,
              y: bounds.y + bounds.height / 2,
            });
          }}
        >
          加入下载任务
        </Button>
        {origin ? (
          <TaskSubmissionFeedback origin={origin} on_complete={finish} />
        ) : null}
      </div>
    );
  },
} satisfies Meta<typeof TaskSubmissionFeedback>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
