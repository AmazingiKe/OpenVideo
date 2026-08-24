import { useEffect, useState } from "react";

const COMPACT_SUMMARY_QUERY = "(max-width: 999px)";

export function use_compact_summary_layout(): boolean {
  const [matches, set_matches] = useState(
    () => window.matchMedia?.(COMPACT_SUMMARY_QUERY).matches ?? false,
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(COMPACT_SUMMARY_QUERY);
    const handle_change = () => set_matches(query.matches);
    handle_change();
    query.addEventListener("change", handle_change);
    return () => query.removeEventListener("change", handle_change);
  }, []);

  return matches;
}
