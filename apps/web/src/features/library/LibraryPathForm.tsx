import { useState, type FormEvent } from "react";
import { FolderOpen, LibraryBig } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LibraryBig aria-hidden="true" />
          选择资料库文件夹
        </CardTitle>
        <CardDescription>
          已有资料库会直接打开；空文件夹会自动初始化为新资料库。
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(error)} data-disabled={disabled}>
              <FieldLabel htmlFor="library_path">文件夹绝对路径</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
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
                  variant="outline"
                  onClick={choose_directory}
                  disabled={disabled || busy}
                >
                  {selecting ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <FolderOpen data-icon="inline-start" />
                  )}
                  {selecting ? "正在选择" : "选择文件夹"}
                </Button>
              </div>
              <FieldDescription>
                也可手动输入绝对路径；没有 library.json 的非空文件夹不会被修改。
              </FieldDescription>
            </Field>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>无法完成操作</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button className="w-full" type="submit" disabled={disabled || busy}>
            {submitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <LibraryBig data-icon="inline-start" />
            )}
            {submitting ? "正在加载资料库" : "使用此文件夹"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
