import type { Transition } from "motion/react";

export const MOTION_EASE_ENTER = [0.22, 1, 0.36, 1] as const;
export const MOTION_EASE_EXIT = [0.4, 0, 1, 1] as const;

export const OVERLAY_ENTER_TRANSITION: Transition = {
  duration: 0.2,
  ease: MOTION_EASE_ENTER,
};
export const OVERLAY_EXIT_TRANSITION: Transition = {
  duration: 0.15,
  ease: MOTION_EASE_EXIT,
};
export const SHEET_ENTER_TRANSITION: Transition = {
  duration: 0.3,
  ease: MOTION_EASE_ENTER,
};
export const SHEET_EXIT_TRANSITION: Transition = {
  duration: 0.2,
  ease: MOTION_EASE_EXIT,
};
export const ASSISTANT_LAYOUT_TRANSITION: Transition = {
  duration: 0.36,
  ease: MOTION_EASE_ENTER,
};
export const ASSISTANT_CONTENT_TRANSITION: Transition = {
  duration: 0.24,
  ease: MOTION_EASE_ENTER,
};

export const DIALOG_ENTER_OFFSET_PX = 8;
export const SHEET_ENTER_OFFSET_PX = 40;
export const ASSISTANT_ENTER_OFFSET_PX = 32;
