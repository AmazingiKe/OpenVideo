import { useState, type FormEvent } from "react";
import { Ellipsis } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { activate_library, select_directory } from "@/shared/api";
import type { LibraryDescription } from "@/shared/types";

export function LibraryPathForm({
  on_success,
  disabled = false,
}: {
  on_success: (library: LibraryDescription) => void;
  disabled?: boolean;
}) {
  const [path, set_path] = useState("");
  const [selecting, set_selecting] = useState(false);
  const [submitting, set_submitting] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const busy = selecting || submitting;

  async function choose_directory() {
    set_selecting(true);
    set_error(null);
    try {
      const selected_path = await select_directory();
      if (selected_path) set_path(selected_path);
    } catch (cause) {
      set_error(cause instanceof Error ? cause.message : "无法选择文件夹");
    } finally {
      set_selecting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) {
      set_error("请填写文件夹的绝对路径");
      return;
    }
    set_submitting(true);
    set_error(null);
    try {
      const library = await activate_library(path.trim());
      on_success(library);
    } catch (cause) {
      set_error(cause instanceof Error ? cause.message : "资料库操作失败");
    } finally {
      set_submitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field data-invalid={Boolean(error)} data-disabled={disabled}>
          <FieldLabel className="sr-only" htmlFor="library_path">
            资料库路径
          </FieldLabel>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
            <Input
              id="library_path"
              value={path}
              onChange={(event) => set_path(event.target.value)}
              placeholder="D:\\OpenVideo"
              disabled={disabled || busy}
              aria-invalid={Boolean(error)}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={choose_directory}
              disabled={disabled || busy}
              aria-label="选择文件夹"
              title="选择文件夹"
            >
              {selecting ? <Spinner /> : <Ellipsis aria-hidden="true" />}
            </Button>
            <Button type="submit" disabled={disabled || busy}>
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              {submitting ? "正在加载" : "使用此文件夹"}
            </Button>
          </div>
        </Field>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>无法完成操作</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </FieldGroup>
    </form>
  );
}
