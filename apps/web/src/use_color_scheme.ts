import { useSyncExternalStore } from "react";

import {
  current_color_scheme,
  subscribe_color_scheme,
  type ColorScheme,
} from "@/color_scheme";

export function use_color_scheme(): ColorScheme {
  return useSyncExternalStore(
    subscribe_color_scheme,
    () => current_color_scheme(),
    () => "light",
  );
}
