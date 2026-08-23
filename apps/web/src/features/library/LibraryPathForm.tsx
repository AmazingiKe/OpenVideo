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
import { create_library, open_library, select_directory } from "@/shared/api";
import type { LibraryDescription } from "@/shared/types";

export type LibraryAction = "initialize" | "open";

const ACTION_CONTENT = {
  initialize: {
    title: "创建资料库",
    description: "选择一个空文件夹，将它初始化为 OpenVideo 资料库。",
    path_label: "文件夹绝对路径",
    submit_label: "初始化文件夹",
    icon: LibraryBig,
  },
  open: {
    title: "打开已有资料库",
    description: "输入包含 library.json 的资料库根目录绝对路径。",
    path_label: "资料库绝对路径",
    submit_label: "打开资料库",
    icon: FolderOpen,
  },
} as const;

export function LibraryPathForm({
  action,
  on_success,
  disabled = false,
}: {
  action: LibraryAction;
  on_success: (library: LibraryDescription) => void;
  disabled?: boolean;
}) {
  const [path, set_path] = useState("");
  const [selecting, set_selecting] = useState(false);
  const [submitting, set_submitting] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const content = ACTION_CONTENT[action];
  const ActionIcon = content.icon;
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
      const library =
        action === "open"
          ? await open_library(path.trim())
          : await create_library(path.trim());
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
          <ActionIcon aria-hidden="true" />
          {content.title}
        </CardTitle>
        <CardDescription>{content.description}</CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(error)} data-disabled={disabled}>
              <FieldLabel htmlFor={`${action}_path`}>
                {content.path_label}
              </FieldLabel>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  id={`${action}_path`}
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
                可直接选择本机文件夹，也可手动输入绝对路径。
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
              <ActionIcon data-icon="inline-start" />
            )}
            {submitting ? "正在处理" : content.submit_label}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
