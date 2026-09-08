import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import {
  TASK_SUBMISSION_END_SCALE,
  TASK_SUBMISSION_TRANSITION,
} from "@/motion_tokens";

export const TASK_CENTER_TRIGGER_ID = "task_center_trigger";

type TaskSubmissionFeedbackProps = {
  origin: { x: number; y: number };
  on_complete: () => void;
};

export function TaskSubmissionFeedback({
  origin,
  on_complete,
}: TaskSubmissionFeedbackProps) {
  const reduced_motion = useReducedMotion();
  const [destination, set_destination] = useState<typeof origin | null>(null);

  useLayoutEffect(() => {
    const target = document.getElementById(TASK_CENTER_TRIGGER_ID);
    if (!target || reduced_motion) {
      on_complete();
      return;
    }
    const bounds = target.getBoundingClientRect();
    set_destination({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
  }, [on_complete, reduced_motion]);

  if (!destination) return null;
  return createPortal(
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-50"
      initial={{ x: origin.x, y: origin.y, opacity: 1, scale: 1 }}
      animate={{
        x: destination.x,
        y: destination.y,
        opacity: [1, 1, 0],
        scale: TASK_SUBMISSION_END_SCALE,
      }}
      transition={TASK_SUBMISSION_TRANSITION}
      onAnimationComplete={on_complete}
    >
      <span className="flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
        <Download className="size-5" />
      </span>
    </motion.div>,
    document.body,
  );
}
