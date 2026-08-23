import { useEffect, useState } from "react";
import {
  Bot,
  Database,
  FolderOpen,
  Info,
  Plus,
  Save,
  Settings2,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { use_library } from "@/app/library";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { LibraryPathForm } from "@/features/library/LibraryPathForm";
import { AiModelConfigurationList } from "@/features/settings/AiModelConfigurationList";
import {
  get_preferences,
  select_directory,
  update_preferences,
} from "@/shared/api";
import type { Preferences } from "@/shared/types";
import { model_id } from "@/shared/identifiers";

type EditableField = "tools_directory" | "models_directory";

export function SettingsPage() {
  const { library, set_library } = use_library();
  const [preferences, set_preferences] = useState<Preferences | null>(null);
  const [saving, set_saving] = useState(false);
  const [message, set_message] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    get_preferences(controller.signal)
      .then(set_preferences)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          set_message(error instanceof Error ? error.message : "读取设置失败");
        }
      });
    return () => controller.abort();
  }, []);

  function update_field(field: EditableField, value: string) {
    set_preferences((current) =>
      current ? { ...current, [field]: value || null } : current,
    );
  }

  function add_ai_model() {
    set_preferences((current) =>
      current
        ? {
            ...current,
            ai_models: [
              ...current.ai_models,
              {
                model_id: model_id(),
                name: "新模型",
                litellm_model: "openai/gpt-5",
                api_key: null,
                api_base: null,
                api_version: null,
                supports_vision: false,
              },
            ],
          }
        : current,
    );
  }

  async function save() {
    if (!preferences) return;
    set_saving(true);
    set_message(null);
    try {
      set_preferences(
        await update_preferences({
          tools_directory: preferences.tools_directory,
          models_directory: preferences.models_directory,
          ai_models: preferences.ai_models,
        }),
      );
      set_message("设置已保存");
    } catch (error) {
      set_message(error instanceof Error ? error.message : "保存设置失败");
    } finally {
      set_saving(false);
    }
  }

  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="settings_page_title"
    >
      <PageHeader
        title_id="settings_page_title"
        eyebrow="系统设置"
        title="配置 OpenVideo 工作环境"
        description="管理当前资料库、本地工具、模型目录和 AI 分析参数。"
        icon={Settings2}
        action={<Badge variant="outline">仅保存在本机</Badge>}
      />

      <SettingsCard
        icon={Database}
        title="当前资料库"
        description="切换成功后，资源与任务状态会按资料库重新加载。"
      >
        <div className="flex flex-col gap-2">
          <p className="font-medium">{library.name}</p>
          <p className="font-mono text-xs break-all text-muted-foreground">
            {library.root_path}
          </p>
          <p className="text-xs text-muted-foreground">
            格式版本 {library.format_version}
          </p>
        </div>
        {preferences?.library_path_managed ? (
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>资料库由环境变量管理</AlertTitle>
            <AlertDescription>
              当前进程无法创建、切换或关闭资料库。
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <LibraryPathForm action="initialize" on_success={set_library} />
            <LibraryPathForm action="open" on_success={set_library} />
          </div>
        )}
      </SettingsCard>

      {!preferences ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner /> 正在读取设置
        </div>
      ) : (
        <>
          {preferences.managed_fields.length > 0 ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>部分字段由环境变量管理</AlertTitle>
              <AlertDescription>
                标记为“环境变量”的字段只读，环境变量值始终优先。
              </AlertDescription>
            </Alert>
          ) : null}
          <SettingsCard
            icon={Wrench}
            title="本地工具与模型"
            description="配置应用统一管理的第三方工具和本地模型根目录。"
          >
            <FieldGroup>
              <div className="grid gap-5 md:grid-cols-2">
                <FfmpegDirectoryInput
                  value={preferences.tools_directory ?? ""}
                  preferences={preferences}
                  on_change={update_field}
                />
                <ModelDirectoryInput
                  value={preferences.models_directory ?? ""}
                  preferences={preferences}
                  on_change={update_field}
                />
              </div>
            </FieldGroup>
          </SettingsCard>
          <SettingsCard
            icon={Bot}
            title="AI 模型"
            description="集中配置 LiteLLM 模型，任务执行时只引用模型标识。"
          >
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>密钥仅保存在本机</AlertTitle>
              <AlertDescription>
                前端执行任务时只发送 model_id，API 密钥保存在 preferences.json。
              </AlertDescription>
            </Alert>
            <AiModelConfigurationList
              models={preferences.ai_models}
              managed={preferences.managed_fields.includes("ai_models")}
              on_change={(ai_models) =>
                set_preferences((current) =>
                  current ? { ...current, ai_models } : current,
                )
              }
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={add_ai_model}
                disabled={preferences.managed_fields.includes("ai_models")}
              >
                <Plus data-icon="inline-start" />
                添加模型
              </Button>
            </div>
          </SettingsCard>
          {message ? (
            <Alert
              variant={message === "设置已保存" ? "default" : "destructive"}
            >
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>{message}</AlertTitle>
            </Alert>
          ) : null}
          <Card>
            <CardFooter className="justify-end">
              <Button type="button" onClick={save} disabled={saving}>
                {saving ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Save data-icon="inline-start" />
                )}
                {saving ? "正在保存" : "保存设置"}
              </Button>
            </CardFooter>
          </Card>
        </>
      )}
    </section>
  );
}

function DirectoryPreferenceInput({
  field,
  label,
  default_path,
  description,
  value,
  preferences,
  on_change,
}: {
  field: "tools_directory" | "models_directory";
  label: string;
  default_path: string;
  description: string;
  value: string;
  preferences: Preferences;
  on_change: (field: EditableField, value: string) => void;
}) {
  const managed = preferences.managed_fields.includes(field);
  const [selecting, set_selecting] = useState(false);

  async function choose_directory() {
    set_selecting(true);
    try {
      const selected_path = await select_directory();
      if (selected_path) on_change(field, selected_path);
    } finally {
      set_selecting(false);
    }
  }

  return (
    <Field data-disabled={managed}>
      <FieldLabel htmlFor={field}>
        {label}
        {managed ? <Badge variant="secondary">环境变量</Badge> : null}
      </FieldLabel>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          id={field}
          value={value}
          onChange={(event) => on_change(field, event.target.value)}
          placeholder={`默认：${default_path}`}
          disabled={managed || selecting}
        />
        <Button
          type="button"
          variant="outline"
          onClick={choose_directory}
          disabled={managed || selecting}
        >
          {selecting ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FolderOpen data-icon="inline-start" />
          )}
          {selecting ? "正在选择" : "选择文件夹"}
        </Button>
      </div>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

function FfmpegDirectoryInput({
  value,
  preferences,
  on_change,
}: {
  value: string;
  preferences: Preferences;
  on_change: (field: EditableField, value: string) => void;
}) {
  return (
    <DirectoryPreferenceInput
      field="tools_directory"
      label="工具目录"
      default_path="runtime/tools"
      description="留空时从 runtime/tools 查找第三方工具；FFmpeg 位于 ffmpeg/bin。"
      value={value}
      preferences={preferences}
      on_change={on_change}
    />
  );
}

function ModelDirectoryInput({
  value,
  preferences,
  on_change,
}: {
  value: string;
  preferences: Preferences;
  on_change: (field: EditableField, value: string) => void;
}) {
  return (
    <DirectoryPreferenceInput
      field="models_directory"
      label="模型目录"
      default_path="runtime/models"
      description="留空时使用 runtime/models；Whisper 模型保存在 faster-whisper 子目录。"
      value={value}
      preferences={preferences}
      on_change={on_change}
    />
  );
}

function SettingsCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Database;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon aria-hidden="true" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">{children}</CardContent>
    </Card>
  );
}
