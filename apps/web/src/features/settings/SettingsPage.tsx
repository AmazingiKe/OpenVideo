import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  Database,
  FolderOpen,
  Info,
  Settings2,
  ScanSearch,
  ShieldCheck,
  Sigma,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { use_library } from "@/app/library";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { error_message, is_abort_error } from "@/shared/errors";
import { is_online_ai_model } from "@/shared/online_ai_models";
import { AgentPreferencesSettings } from "@/features/settings/AgentPreferencesSettings";
import { AiModelConfigurationList } from "@/features/settings/AiModelConfigurationList";
import { TranscriptionModelSettings } from "@/features/settings/TranscriptionModelSettings";
import { FormulaRecognitionSettings } from "@/features/settings/FormulaRecognitionSettings";
import { VisualIndexSettings } from "@/features/settings/VisualIndexSettings";
import {
  get_formula_model,
  get_preferences,
  list_ai_models,
  list_transcription_models,
  select_directory,
  test_ai_model,
  update_preferences,
} from "@/shared/api";
import type {
  AiModelConfiguration,
  AiModelSummary,
  AiModelTestResult,
  FormulaModelState,
  Preferences,
  TranscriptionModelDescriptor,
} from "@/shared/types";

type EditableField = "tools_directory" | "models_directory" | "download_proxy";

const SETTINGS_SAVE_DELAY_MS = 500;

export function SettingsPage() {
  const { library, set_library } = use_library();
  const query_client = useQueryClient();
  const [preferences, set_preferences] = useState<Preferences | null>(null);
  const [transcription_models, set_transcription_models] = useState<
    TranscriptionModelDescriptor[]
  >([]);
  const [formula_model, set_formula_model] = useState<FormulaModelState | null>(
    null,
  );
  const [ai_model_summaries, set_ai_model_summaries] = useState<
    AiModelSummary[]
  >([]);
  const [saving, set_saving] = useState(false);
  const [message, set_message] = useState<string | null>(null);
  const saved_preferences_ref = useRef<Preferences | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      get_preferences(controller.signal),
      list_transcription_models(controller.signal),
      get_formula_model(controller.signal),
      list_ai_models(controller.signal),
    ])
      .then(([loaded_preferences, models, loaded_formula_model, ai_models]) => {
        set_preferences(loaded_preferences);
        saved_preferences_ref.current = loaded_preferences;
        set_transcription_models(models);
        set_formula_model(loaded_formula_model);
        set_ai_model_summaries(ai_models);
        query_client.setQueryData(
          RESOURCE_QUERY_KEYS.preferences,
          loaded_preferences,
        );
        query_client.setQueryData(RESOURCE_QUERY_KEYS.ai_models, ai_models);
      })
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_message(error_message(error));
      });
    return () => controller.abort();
  }, [query_client]);

  useEffect(() => {
    if (preferences === null || preferences === saved_preferences_ref.current)
      return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      set_saving(true);
      set_message(null);
      void update_preferences(
        {
          tools_directory: preferences.tools_directory,
          models_directory: preferences.models_directory,
          download_proxy: preferences.download_proxy,
          default_transcription: preferences.default_transcription,
          ai_models: preferences.ai_models,
          agent: preferences.agent,
        },
        controller.signal,
      )
        .then(async (saved_preferences) => {
          saved_preferences_ref.current = preferences;
          query_client.setQueryData(
            RESOURCE_QUERY_KEYS.preferences,
            saved_preferences,
          );
          void query_client.invalidateQueries({
            queryKey: RESOURCE_QUERY_KEYS.agent_definitions,
          });
          const ai_models = await list_ai_models(controller.signal);
          set_ai_model_summaries(ai_models);
          query_client.setQueryData(RESOURCE_QUERY_KEYS.ai_models, ai_models);
          await query_client.invalidateQueries({
            queryKey: RESOURCE_QUERY_KEYS.transcription_resources,
          });
        })
        .catch((error: unknown) => {
          if (!is_abort_error(error)) set_message(error_message(error));
        })
        .finally(() => set_saving(false));
    }, SETTINGS_SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [preferences, query_client]);

  function update_field(field: EditableField, value: string) {
    set_preferences((current) =>
      current ? { ...current, [field]: value || null } : current,
    );
  }

  function update_ai_models(ai_models: Preferences["ai_models"]) {
    const available_model_ids = new Set(
      ai_models.map((model) => model.model_id),
    );
    set_preferences((current) =>
      current
        ? {
            ...current,
            ai_models,
            agent: {
              ...current.agent,
              fast_model_id: retained_model_id(
                current.agent.fast_model_id,
                available_model_ids,
              ),
              complex_model_id: retained_model_id(
                current.agent.complex_model_id,
                available_model_ids,
              ),
              vision_model_id: retained_model_id(
                current.agent.vision_model_id,
                available_model_ids,
              ),
            },
          }
        : current,
    );
  }

  async function test_and_refresh_ai_model(
    model: AiModelConfiguration,
  ): Promise<AiModelTestResult> {
    const result = await test_ai_model(model);
    const summary = ai_model_summary(model, result);
    set_ai_model_summaries((current) =>
      replace_ai_model_summary(current, summary),
    );
    query_client.setQueryData<AiModelSummary[]>(
      RESOURCE_QUERY_KEYS.ai_models,
      (current = []) => replace_ai_model_summary(current, summary),
    );
    void query_client.invalidateQueries({
      queryKey: RESOURCE_QUERY_KEYS.agent_definitions,
    });
    return result;
  }

  function update_transcription_model(
    updated_model: TranscriptionModelDescriptor,
  ) {
    set_transcription_models((current) =>
      current.map((model) =>
        model.engine === updated_model.engine &&
        model.model === updated_model.model
          ? updated_model
          : model,
      ),
    );
    if (
      updated_model.installation_status === "installed" ||
      updated_model.installation_status === "failed"
    ) {
      void query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.transcription_resources,
      });
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
          <div className="max-w-2xl">
            <LibraryPathForm on_success={set_library} />
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
            title="本地工具"
            description="配置应用统一管理的第三方媒体处理工具。"
          >
            <FieldGroup>
              <FfmpegDirectoryInput
                value={preferences.tools_directory ?? ""}
                preferences={preferences}
                on_change={update_field}
              />
              <DownloadProxyInput
                value={preferences.download_proxy ?? ""}
                preferences={preferences}
                on_change={update_field}
              />
            </FieldGroup>
          </SettingsCard>
          <SettingsCard
            icon={AudioLines}
            title="转录模型"
            description="管理语音识别模型、默认方案和本地推理参数。"
          >
            <FieldGroup>
              <ModelDirectoryInput
                value={preferences.models_directory ?? ""}
                preferences={preferences}
                on_change={update_field}
              />
            </FieldGroup>
            <TranscriptionModelSettings
              models={transcription_models}
              value={preferences.default_transcription}
              on_change={(default_transcription) =>
                set_preferences((current) =>
                  current ? { ...current, default_transcription } : current,
                )
              }
              on_model_change={update_transcription_model}
            />
          </SettingsCard>
          {formula_model ? (
            <SettingsCard
              icon={Sigma}
              title="数学公式识别"
              description="使用视频关键帧补足音频转录无法表达的数学符号与排版结构。"
            >
              <FormulaRecognitionSettings
                model={formula_model}
                on_change={set_formula_model}
              />
            </SettingsCard>
          ) : null}
          <SettingsCard
            icon={ScanSearch}
            title="视觉检索"
            description="为需要画面语义检索的 Agent 与自动配图准备本地索引。"
          >
            <VisualIndexSettings />
          </SettingsCard>
          <SettingsCard
            icon={Bot}
            title="AI 模型"
            description="集中配置在线 AI 模型 API，任务执行时只引用模型标识。"
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
              profiles={Object.fromEntries(
                ai_model_summaries.map((model) => [
                  model.model_id,
                  model.profile,
                ]),
              )}
              managed={preferences.managed_fields.includes("ai_models")}
              on_test_model={test_and_refresh_ai_model}
              on_change={update_ai_models}
            />
          </SettingsCard>
          <SettingsCard
            icon={ShieldCheck}
            title="助手偏好"
            description="为所有对话设置默认权限、思考方式和模型角色。"
          >
            <AgentPreferencesSettings
              value={preferences.agent}
              models={preferences.ai_models.filter(is_online_ai_model)}
              on_change={(agent) =>
                set_preferences((current) =>
                  current ? { ...current, agent } : current,
                )
              }
            />
          </SettingsCard>
          {message ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>保存失败</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            {saving ? <Spinner /> : null}
            {saving ? "正在保存设置" : "设置更改后会自动保存"}
          </p>
        </>
      )}
    </section>
  );
}

function retained_model_id(
  model_id: string | null,
  available_model_ids: Set<string>,
) {
  return model_id !== null && available_model_ids.has(model_id)
    ? model_id
    : null;
}

function ai_model_summary(
  model: AiModelConfiguration,
  result: AiModelTestResult,
): AiModelSummary {
  return {
    model_id: model.model_id,
    name: model.name,
    litellm_model: model.litellm_model,
    input_modalities: model.input_modalities,
    capabilities: model.capabilities,
    profile: result.profile,
  };
}

function replace_ai_model_summary(
  summaries: AiModelSummary[],
  updated_summary: AiModelSummary,
): AiModelSummary[] {
  const summary_exists = summaries.some(
    (summary) => summary.model_id === updated_summary.model_id,
  );
  if (!summary_exists) return [...summaries, updated_summary];
  return summaries.map((summary) =>
    summary.model_id === updated_summary.model_id ? updated_summary : summary,
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
      default_path="系统用户配置目录/OpenVideo/models"
      description="留空时使用系统用户配置目录中的 OpenVideo/models；不同转录引擎分别使用独立子目录。"
      value={value}
      preferences={preferences}
      on_change={on_change}
    />
  );
}

function DownloadProxyInput({
  value,
  preferences,
  on_change,
}: {
  value: string;
  preferences: Preferences;
  on_change: (field: EditableField, value: string) => void;
}) {
  const managed = preferences.managed_fields.includes("download_proxy");
  return (
    <Field data-disabled={managed}>
      <FieldLabel htmlFor="download_proxy">
        海外平台下载代理（可选）
        {managed ? <Badge variant="secondary">环境变量</Badge> : null}
      </FieldLabel>
      <Input
        id="download_proxy"
        value={value}
        onChange={(event) => on_change("download_proxy", event.target.value)}
        placeholder="例如：http://127.0.0.1:7890"
        disabled={managed}
        spellCheck={false}
      />
      <FieldDescription>
        国内平台默认直连；YouTube 等平台无法访问时可填写本机 HTTP 或 SOCKS
        代理，留空则使用系统网络。
      </FieldDescription>
    </Field>
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
        <CardTitle
          className="flex items-center gap-2"
          role="heading"
          aria-level={2}
        >
          <Icon aria-hidden="true" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">{children}</CardContent>
    </Card>
  );
}
