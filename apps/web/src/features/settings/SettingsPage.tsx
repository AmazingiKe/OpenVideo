import { useEffect, useState } from "react";
import {
  Bot,
  Database,
  Info,
  Save,
  Settings2,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { use_library } from "@/app/library";
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
import { get_preferences, update_preferences } from "@/shared/api";
import type { Preferences } from "@/shared/types";

type EditableField = Exclude<
  keyof Preferences,
  "managed_fields" | "library_path_managed"
>;

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

  async function save() {
    if (!preferences) return;
    set_saving(true);
    set_message(null);
    try {
      set_preferences(
        await update_preferences({
          ffmpeg_path: preferences.ffmpeg_path,
          ffprobe_path: preferences.ffprobe_path,
          whisper_model: preferences.whisper_model,
          whisper_language: preferences.whisper_language,
          whisper_compute_type: preferences.whisper_compute_type,
          openai_base_url: preferences.openai_base_url,
          openai_api_key: preferences.openai_api_key,
          vision_model: preferences.vision_model,
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
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="flex max-w-2xl flex-col gap-3">
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <Settings2 aria-hidden="true" />
            系统设置
          </span>
          <h1
            id="settings_page_title"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            配置 OpenVideo 工作环境
          </h1>
          <p className="text-muted-foreground">
            管理当前资料库、本地媒体工具、转写和 AI 分析参数。
          </p>
        </div>
        <Badge variant="outline">仅保存在本机</Badge>
      </header>

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
            title="媒体工具与转写"
            description="留空时从应用工具目录和系统 PATH 查找。"
          >
            <FieldGroup>
              <div className="grid gap-5 md:grid-cols-2">
                <PreferenceInput
                  field="ffmpeg_path"
                  label="FFmpeg 路径"
                  value={preferences.ffmpeg_path ?? ""}
                  preferences={preferences}
                  on_change={update_field}
                />
                <PreferenceInput
                  field="ffprobe_path"
                  label="FFprobe 路径"
                  value={preferences.ffprobe_path ?? ""}
                  preferences={preferences}
                  on_change={update_field}
                />
                <PreferenceInput
                  field="whisper_model"
                  label="Whisper 模型"
                  value={preferences.whisper_model}
                  preferences={preferences}
                  on_change={update_field}
                />
                <PreferenceInput
                  field="whisper_language"
                  label="转写语言"
                  value={preferences.whisper_language ?? ""}
                  preferences={preferences}
                  on_change={update_field}
                />
                <PreferenceInput
                  field="whisper_compute_type"
                  label="计算精度"
                  value={preferences.whisper_compute_type}
                  preferences={preferences}
                  on_change={update_field}
                />
              </div>
            </FieldGroup>
          </SettingsCard>
          <SettingsCard
            icon={Bot}
            title="AI 分析"
            description="连接 OpenAI 兼容接口，为关键帧补充视觉理解。"
          >
            <FieldGroup>
              <PreferenceInput
                field="openai_base_url"
                label="接口地址"
                value={preferences.openai_base_url}
                preferences={preferences}
                on_change={update_field}
              />
              <div className="grid gap-5 md:grid-cols-2">
                <PreferenceInput
                  field="openai_api_key"
                  label="API 密钥"
                  value={preferences.openai_api_key ?? ""}
                  type="password"
                  description="密钥将以明文保存在本机 preferences.json。"
                  preferences={preferences}
                  on_change={update_field}
                />
                <PreferenceInput
                  field="vision_model"
                  label="视觉模型"
                  value={preferences.vision_model}
                  preferences={preferences}
                  on_change={update_field}
                />
              </div>
            </FieldGroup>
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

function PreferenceInput({
  field,
  label,
  value,
  preferences,
  on_change,
  type = "text",
  description,
}: {
  field: EditableField;
  label: string;
  value: string;
  preferences: Preferences;
  on_change: (field: EditableField, value: string) => void;
  type?: "text" | "password";
  description?: string;
}) {
  const managed = preferences.managed_fields.includes(field);
  return (
    <Field data-disabled={managed}>
      <FieldLabel htmlFor={field}>
        {label}
        {managed ? <Badge variant="secondary">环境变量</Badge> : null}
      </FieldLabel>
      <Input
        id={field}
        type={type}
        value={value}
        onChange={(event) => on_change(field, event.target.value)}
        disabled={managed}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
