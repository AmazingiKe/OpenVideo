import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { apply_user_color_scheme, type ColorScheme } from "@/color_scheme";
import type { SummaryPlayerGeometry } from "@/shared/types";

export const LOCAL_PREFERENCES_STORAGE_KEY = "openvideo.local-preferences";

const LOCAL_PREFERENCES_VERSION = 1;

export type LocalPreferences = {
  assistant_open: boolean | null;
  color_scheme: ColorScheme | null;
  summary_player_geometry: SummaryPlayerGeometry | null;
  summary_player_open: boolean | null;
  video_library_open: boolean | null;
};

type LocalPreferencesContextValue = {
  preferences: LocalPreferences;
  set_assistant_open: (open: boolean) => void;
  set_color_scheme: (color_scheme: ColorScheme) => void;
  set_summary_player_geometry: (geometry: SummaryPlayerGeometry) => void;
  set_summary_player_open: (open: boolean) => void;
  set_video_library_open: (open: boolean) => void;
};

type StoredLocalPreferences = {
  version: typeof LOCAL_PREFERENCES_VERSION;
  assistant_open?: boolean;
  color_scheme?: ColorScheme;
  summary_player_geometry?: SummaryPlayerGeometry;
  summary_player_open?: boolean;
  video_library_open?: boolean;
};

const EMPTY_LOCAL_PREFERENCES: LocalPreferences = {
  assistant_open: null,
  color_scheme: null,
  summary_player_geometry: null,
  summary_player_open: null,
  video_library_open: null,
};

const LocalPreferencesContext =
  createContext<LocalPreferencesContextValue | null>(null);

export function LocalPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [preferences, set_preferences] = useState(read_local_preferences);

  useLayoutEffect(() => {
    if (preferences.color_scheme) {
      apply_user_color_scheme(document, preferences.color_scheme);
    }
  }, [preferences.color_scheme]);

  useEffect(() => persist_local_preferences(preferences), [preferences]);

  const set_assistant_open = useCallback((assistant_open: boolean) => {
    set_preferences((current) => ({ ...current, assistant_open }));
  }, []);
  const set_color_scheme = useCallback((color_scheme: ColorScheme) => {
    set_preferences((current) => ({ ...current, color_scheme }));
  }, []);
  const set_summary_player_geometry = useCallback(
    (summary_player_geometry: SummaryPlayerGeometry) => {
      set_preferences((current) => ({ ...current, summary_player_geometry }));
    },
    [],
  );
  const set_summary_player_open = useCallback(
    (summary_player_open: boolean) => {
      set_preferences((current) => ({ ...current, summary_player_open }));
    },
    [],
  );
  const set_video_library_open = useCallback((video_library_open: boolean) => {
    set_preferences((current) => ({ ...current, video_library_open }));
  }, []);
  const value = useMemo(
    () => ({
      preferences,
      set_assistant_open,
      set_color_scheme,
      set_summary_player_geometry,
      set_summary_player_open,
      set_video_library_open,
    }),
    [
      preferences,
      set_assistant_open,
      set_color_scheme,
      set_summary_player_geometry,
      set_summary_player_open,
      set_video_library_open,
    ],
  );

  return (
    <LocalPreferencesContext.Provider value={value}>
      {children}
    </LocalPreferencesContext.Provider>
  );
}

export function use_local_preferences(): LocalPreferencesContextValue {
  // 项目命名规范要求 snake_case；该函数仍是标准 React Hook。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const value = useContext(LocalPreferencesContext);
  if (!value) {
    throw new Error(
      "use_local_preferences 必须在 LocalPreferencesProvider 内使用",
    );
  }
  return value;
}

export function read_local_preferences(
  storage: Pick<Storage, "getItem"> | null = browser_local_storage(),
): LocalPreferences {
  if (!storage) return EMPTY_LOCAL_PREFERENCES;
  try {
    const serialized = storage.getItem(LOCAL_PREFERENCES_STORAGE_KEY);
    if (!serialized) return EMPTY_LOCAL_PREFERENCES;
    const stored: unknown = JSON.parse(serialized);
    if (!is_record(stored) || stored.version !== LOCAL_PREFERENCES_VERSION) {
      return EMPTY_LOCAL_PREFERENCES;
    }
    return {
      assistant_open:
        typeof stored.assistant_open === "boolean"
          ? stored.assistant_open
          : null,
      color_scheme:
        stored.color_scheme === "light" || stored.color_scheme === "dark"
          ? stored.color_scheme
          : null,
      summary_player_geometry: parse_summary_player_geometry(
        stored.summary_player_geometry,
      ),
      summary_player_open:
        typeof stored.summary_player_open === "boolean"
          ? stored.summary_player_open
          : null,
      video_library_open:
        typeof stored.video_library_open === "boolean"
          ? stored.video_library_open
          : null,
    };
  } catch {
    return EMPTY_LOCAL_PREFERENCES;
  }
}

function persist_local_preferences(
  preferences: LocalPreferences,
  storage: Pick<Storage, "setItem"> | null = browser_local_storage(),
): void {
  if (!storage) return;
  const stored: StoredLocalPreferences = {
    version: LOCAL_PREFERENCES_VERSION,
  };
  if (preferences.assistant_open !== null) {
    stored.assistant_open = preferences.assistant_open;
  }
  if (preferences.color_scheme !== null) {
    stored.color_scheme = preferences.color_scheme;
  }
  if (preferences.summary_player_geometry !== null) {
    stored.summary_player_geometry = preferences.summary_player_geometry;
  }
  if (preferences.summary_player_open !== null) {
    stored.summary_player_open = preferences.summary_player_open;
  }
  if (preferences.video_library_open !== null) {
    stored.video_library_open = preferences.video_library_open;
  }
  try {
    storage.setItem(LOCAL_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // 浏览器禁用存储时仍允许当前会话继续使用内存中的偏好。
  }
}

function browser_local_storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse_summary_player_geometry(
  value: unknown,
): SummaryPlayerGeometry | null {
  if (!is_record(value)) return null;
  const { x, y, width, height } = value;
  if (
    !is_finite_number(x) ||
    !is_finite_number(y) ||
    !is_finite_number(width) ||
    !is_finite_number(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function is_finite_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
