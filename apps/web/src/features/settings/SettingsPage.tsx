import { useState } from "react";
import {
  Bot,
  BrainCircuit,
  Database,
  Info,
  RotateCcw,
  Save,
  Settings2,
  Wrench,
} from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const DEFAULT_SETTINGS = {
  library_path: "./library",
  ffmpeg_path: "",
  ffprobe_path: "",
  whisper_model: "small",
  whisper_language: "zh",
  whisper_compute_type: "int8",
  openai_base_url: "https://api.openai.com/v1",
  openai_api_key: "",
  vision_model: "gpt-5.6-terra",
};

type SettingsDraft = typeof DEFAULT_SETTINGS;

export function SettingsPage() {
  const [settings, set_settings] = useState<SettingsDraft>(DEFAULT_SETTINGS);
  const [detect_language, set_detect_language] = useState(false);

  function update_setting(field: keyof SettingsDraft, value: string) {
    set_settings((current) => ({ ...current, [field]: value }));
  }

  function reset_settings() {
    set_settings(DEFAULT_SETTINGS);
    set_detect_language(false);
  }

  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="settings_page_title"
    >
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
            <Settings2 className="size-4" aria-hidden="true" />
            系统设置
          </div>
          <h1
            id="settings_page_title"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            配置 OpenVideo 工作环境
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            管理媒体存储、本地转写和 AI 视觉分析所使用的服务参数。
          </p>
        </div>
        <Badge className="w-fit" variant="outline">
          配置草稿
        </Badge>
      </header>

      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>当前配置由后端环境变量管理</AlertTitle>
        <AlertDescription>
          此页面先用于确认设置结构与交互。保存接口接入前，修改不会影响正在运行的任务。
        </AlertDescription>
      </Alert>

      <div className="grid items-start gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          className="flex gap-2 overflow-x-auto rounded-xl border bg-card p-2 lg:sticky lg:top-6 lg:flex-col"
          aria-label="设置分类"
        >
          <SettingsSectionLink href="#storage_settings" icon={Database}>
            存储与工具
          </SettingsSectionLink>
          <SettingsSectionLink
            href="#transcription_settings"
            icon={BrainCircuit}
          >
            本地转写
          </SettingsSectionLink>
          <SettingsSectionLink href="#ai_settings" icon={Bot}>
            AI 分析
          </SettingsSectionLink>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          <SettingsCard
            id="storage_settings"
            icon={Database}
            title="存储与工具"
            description="设置媒体库位置，以及视频处理工具的可执行文件路径。"
          >
            <FieldGroup>
              <SettingsInput
                id="library_path"
                label="媒体库路径"
                value={settings.library_path}
                description="视频、缩略图、转写和分析结果会集中保存在此目录。"
                placeholder="./library"
                on_value_change={(value) =>
                  update_setting("library_path", value)
                }
              />
              <div className="grid gap-5 md:grid-cols-2">
                <SettingsInput
                  id="ffmpeg_path"
                  label="FFmpeg 路径"
                  value={settings.ffmpeg_path}
                  description="留空时从系统 PATH 和项目工具目录查找。"
                  placeholder="自动检测"
                  on_value_change={(value) =>
                    update_setting("ffmpeg_path", value)
                  }
                />
                <SettingsInput
                  id="ffprobe_path"
                  label="FFprobe 路径"
                  value={settings.ffprobe_path}
                  description="留空时跟随 FFmpeg 的查找规则。"
                  placeholder="自动检测"
                  on_value_change={(value) =>
                    update_setting("ffprobe_path", value)
                  }
                />
              </div>
            </FieldGroup>
          </SettingsCard>

          <SettingsCard
            id="transcription_settings"
            icon={BrainCircuit}
            title="本地转写"
            description="配置 Whisper 模型、语言提示和本地推理精度。"
          >
            <FieldGroup>
              <div className="grid gap-5 md:grid-cols-2">
                <SettingsInput
                  id="whisper_model"
                  label="Whisper 模型"
                  value={settings.whisper_model}
                  description="可使用 tiny、base、small、medium 或 large。"
                  placeholder="small"
                  on_value_change={(value) =>
                    update_setting("whisper_model", value)
                  }
                />
                <SettingsInput
                  id="whisper_compute_type"
                  label="计算精度"
                  value={settings.whisper_compute_type}
                  description="CPU 环境推荐使用 int8。"
                  placeholder="int8"
                  on_value_change={(value) =>
                    update_setting("whisper_compute_type", value)
                  }
                />
              </div>
              <Field data-disabled={detect_language}>
                <FieldLabel htmlFor="whisper_language">转写语言</FieldLabel>
                <Input
                  id="whisper_language"
                  value={settings.whisper_language}
                  onChange={(event) =>
                    update_setting("whisper_language", event.target.value)
                  }
                  placeholder="zh"
                  disabled={detect_language}
                />
                <FieldDescription>
                  输入 ISO 语言代码，或启用自动检测。
                </FieldDescription>
              </Field>
              <Field className="flex-row items-start">
                <Checkbox
                  id="detect_language"
                  aria-label="自动检测语言"
                  checked={detect_language}
                  onCheckedChange={(checked) =>
                    set_detect_language(checked === true)
                  }
                />
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="detect_language">
                    自动检测语言
                  </FieldLabel>
                  <FieldDescription>
                    不向 Whisper 提供固定语言提示，适合多语言素材。
                  </FieldDescription>
                </div>
              </Field>
            </FieldGroup>
          </SettingsCard>

          <SettingsCard
            id="ai_settings"
            icon={Bot}
            title="AI 分析"
            description="连接 OpenAI 兼容接口，为关键帧补充视觉理解。"
          >
            <FieldGroup>
              <SettingsInput
                id="openai_base_url"
                label="接口地址"
                value={settings.openai_base_url}
                description="支持 OpenAI 官方接口或兼容网关。"
                placeholder="https://api.openai.com/v1"
                type="url"
                on_value_change={(value) =>
                  update_setting("openai_base_url", value)
                }
              />
              <div className="grid gap-5 md:grid-cols-2">
                <SettingsInput
                  id="openai_api_key"
                  label="API 密钥"
                  value={settings.openai_api_key}
                  description="留空时仅生成音频时间轴。"
                  placeholder="未配置"
                  type="password"
                  on_value_change={(value) =>
                    update_setting("openai_api_key", value)
                  }
                />
                <SettingsInput
                  id="vision_model"
                  label="视觉模型"
                  value={settings.vision_model}
                  description="用于多帧画面与转写内容的联合分析。"
                  placeholder="gpt-5.6-terra"
                  on_value_change={(value) =>
                    update_setting("vision_model", value)
                  }
                />
              </div>
            </FieldGroup>
          </SettingsCard>

          <Card>
            <CardFooter className="flex-col justify-between gap-4 sm:flex-row">
              <p className="text-sm text-muted-foreground">
                保存能力将在后端设置接口接入后启用。
              </p>
              <div className="flex w-full gap-2 sm:w-auto">
                <Button
                  className="flex-1 sm:flex-none"
                  type="button"
                  variant="outline"
                  onClick={reset_settings}
                >
                  <RotateCcw data-icon="inline-start" />
                  恢复默认值
                </Button>
                <Button className="flex-1 sm:flex-none" type="button" disabled>
                  <Save data-icon="inline-start" />
                  保存设置
                </Button>
              </div>
            </CardFooter>
          </Card>
        </div>
      </div>
    </section>
  );
}

function SettingsSectionLink({
  href,
  icon: LinkIcon,
  children,
}: {
  href: string;
  icon: typeof Database;
  children: string;
}) {
  return (
    <a
      className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      href={href}
    >
      <LinkIcon className="size-4" aria-hidden="true" />
      {children}
    </a>
  );
}

function SettingsCard({
  id,
  icon: SectionIcon,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof Wrench;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader className="border-b">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
            <SectionIcon aria-hidden="true" />
          </div>
          <div>
            <CardTitle role="heading" aria-level={2}>
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SettingsInput({
  id,
  label,
  value,
  description,
  placeholder,
  type = "text",
  on_value_change,
}: {
  id: string;
  label: string;
  value: string;
  description: string;
  placeholder: string;
  type?: "text" | "url" | "password";
  on_value_change: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => on_value_change(event.target.value)}
        placeholder={placeholder}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}
