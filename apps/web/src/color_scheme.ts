const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function initialize_color_scheme(
  document_object: Document,
  window_object: Pick<Window, "matchMedia">,
): void {
  const media_query = window_object.matchMedia(DARK_COLOR_SCHEME_QUERY);
  const apply_color_scheme = ({ matches }: Pick<MediaQueryList, "matches">) => {
    document_object.documentElement.classList.toggle("dark", matches);
  };

  apply_color_scheme(media_query);
  media_query.addEventListener("change", apply_color_scheme);
}
