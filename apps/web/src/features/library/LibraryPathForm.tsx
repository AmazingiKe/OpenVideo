import { useState, type FormEvent } from "react";
import { FolderOpen, LibraryBig, Plus } from "lucide-react";

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
import { create_library, open_library } from "@/shared/api";
import type { LibraryDescription } from "@/shared/types";

export type LibraryAction = "parent" | "empty_directory" | "open";

const ACTION_CONTENT = {
  parent: {
    title: "新建专用资料库",
    description: "在父目录中创建一个以 .openvideo-library 结尾的专用目录。",
    path_label: "父目录绝对路径",
    submit_label: "新建资料库",
    icon: Plus,
  },
  empty_directory: {
    title: "初始化空目录",
    description: "将已有空目录直接初始化为资料库，并保留目录名称。",
    path_label: "空目录绝对路径",
    submit_label: "初始化目录",
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
  const [name, set_name] = useState("");
  const [submitting, set_submitting] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const content = ACTION_CONTENT[action];
  const ActionIcon = content.icon;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim() || (action === "parent" && !name.trim())) {
      set_error("请填写完整的绝对路径和资料库名称");
      return;
    }
    set_submitting(true);
    set_error(null);
    try {
      const library =
        action === "open"
          ? await open_library(path.trim())
          : await create_library(
              action === "parent"
                ? { mode: "parent", path: path.trim(), name: name.trim() }
                : { mode: "empty_directory", path: path.trim() },
            );
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
              <Input
                id={`${action}_path`}
                value={path}
                onChange={(event) => set_path(event.target.value)}
                placeholder="D:\\OpenVideo"
                disabled={disabled || submitting}
                aria-invalid={Boolean(error)}
              />
              <FieldDescription>
                Web 版仅接受本机文件系统的绝对路径。
              </FieldDescription>
            </Field>
            {action === "parent" ? (
              <Field data-invalid={Boolean(error)} data-disabled={disabled}>
                <FieldLabel htmlFor="library_name">资料库名称</FieldLabel>
                <Input
                  id="library_name"
                  value={name}
                  onChange={(event) => set_name(event.target.value)}
                  placeholder="我的视频"
                  disabled={disabled || submitting}
                  aria-invalid={Boolean(error)}
                />
              </Field>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>无法完成操作</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button
            className="w-full"
            type="submit"
            disabled={disabled || submitting}
          >
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
