import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { LibrarySetup } from "@/features/library/LibrarySetup";
import { get_library } from "@/shared/api";
import type { LibraryDescription } from "@/shared/types";
import { Spinner } from "@/components/ui/spinner";

type LibraryContextValue = {
  library: LibraryDescription;
  set_library: (library: LibraryDescription | null) => void;
};

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [library, set_library] = useState<LibraryDescription | null>(null);
  const [loading, set_loading] = useState(true);
  const [notice, set_notice] = useState<string | null>(null);

  const load_library = useCallback(async (signal?: AbortSignal) => {
    try {
      set_library(await get_library(signal));
      set_notice(null);
    } catch {
      if (!signal?.aborted) {
        set_notice("请选择一个资料库，或选择一个空文件夹创建新的资料库。");
      }
    } finally {
      if (!signal?.aborted) set_loading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load_library(controller.signal);
    return () => controller.abort();
  }, [load_library]);

  const value = useMemo(
    () => (library ? { library, set_library } : null),
    [library],
  );

  if (loading) {
    return (
      <main className="grid min-h-svh place-items-center" role="status">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          正在读取资料库
        </span>
      </main>
    );
  }

  if (!library) {
    return (
      <LibrarySetup
        notice={notice}
        on_library_opened={(opened_library) => set_library(opened_library)}
      />
    );
  }

  return (
    <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
  );
}

export function use_library(): LibraryContextValue {
  // 项目命名规范要求 snake_case；该函数仍是标准 React Hook。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const value = useContext(LibraryContext);
  if (!value)
    throw new Error("use_library 必须在已打开资料库的 LibraryProvider 内使用");
  return value;
}
