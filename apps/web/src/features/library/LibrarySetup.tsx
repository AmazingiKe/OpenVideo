import { Database, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LibraryPathForm } from "@/features/library/LibraryPathForm";
import type { LibraryDescription } from "@/shared/types";

export function LibrarySetup({
  error,
  on_library_opened,
}: {
  error?: string | null;
  on_library_opened: (library: LibraryDescription) => void;
}) {
  return (
    <main className="min-h-svh bg-muted/30 px-4 py-12 md:px-8 md:py-20">
      <section
        className="mx-auto flex w-full max-w-6xl flex-col gap-8"
        aria-labelledby="library_setup_title"
      >
        <header className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Database aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <h1
              id="library_setup_title"
              className="text-3xl font-semibold tracking-tight"
            >
              选择 OpenVideo 资料库
            </h1>
            <p className="text-pretty text-muted-foreground">
              资料库包含 SQLite 数据库、媒体和分析产物，可整体移动、备份和恢复。
            </p>
          </div>
        </header>
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>无法读取上次的资料库</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <LibraryPathForm action="parent" on_success={on_library_opened} />
          <LibraryPathForm
            action="empty_directory"
            on_success={on_library_opened}
          />
          <LibraryPathForm action="open" on_success={on_library_opened} />
        </div>
      </section>
    </main>
  );
}
