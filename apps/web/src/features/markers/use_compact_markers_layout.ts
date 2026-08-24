import { useEffect, useState } from "react";

const COMPACT_LAYOUT_QUERY = "(max-width: 979px)";

export function use_compact_markers_layout(): boolean {
  const [matches, set_matches] = useState(
    () => window.matchMedia?.(COMPACT_LAYOUT_QUERY).matches ?? false,
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const media_query = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const handle_change = () => set_matches(media_query.matches);
    handle_change();
    media_query.addEventListener("change", handle_change);
    return () => media_query.removeEventListener("change", handle_change);
  }, []);

  return matches;
}
