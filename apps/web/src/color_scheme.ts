const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const COLOR_SCHEME_CHANGE_EVENT = "openvideo:color-scheme-change";
const COLOR_SCHEME_SOURCE_ATTRIBUTE = "data-color-scheme-source";
const USER_COLOR_SCHEME_SOURCE = "user";

export type ColorScheme = "light" | "dark";

function color_scheme_from_system(matches: boolean): ColorScheme {
  return matches ? "dark" : "light";
}

function apply_color_scheme(
  document_object: Document,
  color_scheme: ColorScheme,
): void {
  const document_element = document_object.documentElement;
  const changed =
    document_element.classList.contains("dark") !== (color_scheme === "dark");
  document_element.classList.toggle("dark", color_scheme === "dark");
  if (changed) {
    document_element.dispatchEvent(new Event(COLOR_SCHEME_CHANGE_EVENT));
  }
}

export function initialize_color_scheme(
  document_object: Document,
  window_object: Pick<Window, "matchMedia">,
): () => void {
  const media_query = window_object.matchMedia(DARK_COLOR_SCHEME_QUERY);
  const apply_system_color_scheme = ({
    matches,
  }: Pick<MediaQueryList, "matches">) => {
    if (
      document_object.documentElement.getAttribute(
        COLOR_SCHEME_SOURCE_ATTRIBUTE,
      ) === USER_COLOR_SCHEME_SOURCE
    ) {
      return;
    }
    apply_color_scheme(document_object, color_scheme_from_system(matches));
  };

  apply_system_color_scheme(media_query);
  media_query.addEventListener("change", apply_system_color_scheme);
  return () =>
    media_query.removeEventListener("change", apply_system_color_scheme);
}

export function current_color_scheme(
  document_object: Document = document,
): ColorScheme {
  return document_object.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

export function toggle_color_scheme(
  document_object: Document = document,
): ColorScheme {
  const next_color_scheme =
    current_color_scheme(document_object) === "dark" ? "light" : "dark";
  document_object.documentElement.setAttribute(
    COLOR_SCHEME_SOURCE_ATTRIBUTE,
    USER_COLOR_SCHEME_SOURCE,
  );
  apply_color_scheme(document_object, next_color_scheme);
  return next_color_scheme;
}

export function subscribe_color_scheme(
  listener: () => void,
  document_object: Document = document,
): () => void {
  const document_element = document_object.documentElement;
  document_element.addEventListener(COLOR_SCHEME_CHANGE_EVENT, listener);
  return () =>
    document_element.removeEventListener(COLOR_SCHEME_CHANGE_EVENT, listener);
}
