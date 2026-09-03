import * as React from "react";
import { motion, type Variants } from "motion/react";

import {
  DIALOG_ENTER_OFFSET_PX,
  OVERLAY_ENTER_TRANSITION,
  OVERLAY_EXIT_TRANSITION,
  SHEET_ENTER_OFFSET_PX,
  SHEET_ENTER_TRANSITION,
  SHEET_EXIT_TRANSITION,
} from "@/motion_tokens";

type OverlayOpenState = {
  open: boolean;
  set_open: (open: boolean) => void;
};

type OverlayOpenOptions = {
  open?: boolean;
  default_open?: boolean;
  on_open_change?: (open: boolean) => void;
};

export type SheetSide = "top" | "right" | "bottom" | "left";

const OVERLAY_VARIANTS: Variants = {
  closed: { opacity: 0, transition: OVERLAY_EXIT_TRANSITION },
  open: { opacity: 1, transition: OVERLAY_ENTER_TRANSITION },
};

const DIALOG_VARIANTS: Variants = {
  closed: {
    scale: 0.96,
    y: DIALOG_ENTER_OFFSET_PX,
    transition: OVERLAY_EXIT_TRANSITION,
  },
  open: {
    scale: 1,
    y: 0,
    transition: OVERLAY_ENTER_TRANSITION,
  },
};

const SHEET_VARIANTS: Variants = {
  closed: (side: SheetSide) => ({
    x:
      side === "left"
        ? -SHEET_ENTER_OFFSET_PX
        : side === "right"
          ? SHEET_ENTER_OFFSET_PX
          : 0,
    y:
      side === "top"
        ? -SHEET_ENTER_OFFSET_PX
        : side === "bottom"
          ? SHEET_ENTER_OFFSET_PX
          : 0,
    transition: SHEET_EXIT_TRANSITION,
  }),
  open: {
    x: 0,
    y: 0,
    transition: SHEET_ENTER_TRANSITION,
  },
};

export function use_overlay_open({
  open: controlled_open,
  default_open = false,
  on_open_change,
}: OverlayOpenOptions): OverlayOpenState {
  // 项目命名规范要求 snake_case；该函数仍是标准 React Hook。
  const [uncontrolled_open, set_uncontrolled_open] =
    // eslint-disable-next-line react-hooks/rules-of-hooks
    React.useState(default_open);
  const open = controlled_open ?? uncontrolled_open;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const set_open = React.useCallback(
    (next_open: boolean) => {
      if (controlled_open === undefined) {
        set_uncontrolled_open(next_open);
      }
      on_open_change?.(next_open);
    },
    [controlled_open, on_open_change],
  );
  return { open, set_open };
}

export function MotionOverlay(props: React.ComponentProps<typeof motion.div>) {
  return (
    <motion.div
      initial="closed"
      animate="open"
      exit="closed"
      variants={OVERLAY_VARIANTS}
      {...props}
    />
  );
}

export function MotionDialogSurface(
  props: React.ComponentProps<typeof motion.div>,
) {
  return (
    <motion.div
      initial="closed"
      animate="open"
      exit="closed"
      variants={DIALOG_VARIANTS}
      {...props}
    />
  );
}

export function MotionSheetSurface({
  side,
  ...props
}: React.ComponentProps<typeof motion.div> & { side: SheetSide }) {
  return (
    <motion.div
      custom={side}
      initial="closed"
      animate="open"
      exit="closed"
      variants={SHEET_VARIANTS}
      {...props}
    />
  );
}
