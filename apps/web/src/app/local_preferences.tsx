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
import type { SummaryPlayerGeometry, SummaryPlayerState } from "@/shared/types";

export const LOCAL_PREFERENCES_STORAGE_KEY = "openvideo.local-preferences";

const LOCAL_PREFERENCES_VERSION = 1;

export type LocalPreferences = {
  assistant_open: boolean | null;
  color_scheme: ColorScheme | null;
  summary_player_states: Record<string, SummaryPlayerState>;
  video_library_open: boolean | null;
};

type LocalPreferencesContextValue = {
  preferences: LocalPreferences;
  set_assistant_open: (open: boolean) => void;
  set_color_scheme: (color_scheme: ColorScheme) => void;
  set_summary_player_geometry: (
    asset_id: string,
    geometry: SummaryPlayerGeometry,
  ) => void;
  set_summary_player_open: (asset_id: string, open: boolean) => void;
  set_video_library_open: (open: boolean) => void;
};

type StoredLocalPreferences = {
  version: typeof LOCAL_PREFERENCES_VERSION;
  assistant_open?: boolean;
  color_scheme?: ColorScheme;
  summary_player_states?: Record<string, SummaryPlayerState>;
  video_library_open?: boolean;
};

const EMPTY_LOCAL_PREFERENCES: LocalPreferences = {
  assistant_open: null,
  color_scheme: null,
  summary_player_states: {},
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
    (asset_id: string, geometry: SummaryPlayerGeometry) => {
      set_preferences((current) => {
        const current_state = current.summary_player_states[asset_id] ?? {
          geometry: null,
          open: false,
        };
        return {
          ...current,
          summary_player_states: {
            ...current.summary_player_states,
            [asset_id]: { ...current_state, geometry },
          },
        };
      });
    },
    [],
  );
  const set_summary_player_open = useCallback(
    (asset_id: string, open: boolean) => {
      set_preferences((current) => {
        const current_state = current.summary_player_states[asset_id] ?? {
          geometry: null,
          open: false,
        };
        return {
          ...current,
          summary_player_states: {
            ...current.summary_player_states,
            [asset_id]: { ...current_state, open },
          },
        };
      });
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
      summary_player_states: parse_summary_player_states(
        stored.summary_player_states,
      ),
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
  if (Object.keys(preferences.summary_player_states).length > 0) {
    stored.summary_player_states = preferences.summary_player_states;
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

function parse_summary_player_states(
  value: unknown,
): Record<string, SummaryPlayerState> {
  if (!is_record(value)) return {};
  const states: Record<string, SummaryPlayerState> = {};
  for (const [asset_id, state] of Object.entries(value)) {
    if (!asset_id || !is_record(state) || typeof state.open !== "boolean") {
      continue;
    }
    const geometry =
      state.geometry === null
        ? null
        : parse_summary_player_geometry(state.geometry);
    if (state.geometry !== null && geometry === null) continue;
    states[asset_id] = { geometry, open: state.open };
  }
  return states;
}

function is_finite_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
