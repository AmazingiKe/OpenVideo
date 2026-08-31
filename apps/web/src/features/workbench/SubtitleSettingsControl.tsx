import { Captions, Check, CircleAlert, Download } from "lucide-react";
import { useId } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  SubtitleBackground,
  SubtitleDisplaySettings,
  SubtitleFontSize,
  SubtitlePosition,
} from "@/shared/types";

type SubtitleSettingsControlProps = {
  settings: SubtitleDisplaySettings;
  has_subtitles: boolean;
  settings_pending: boolean;
  export_pending: boolean;
  export_relative_path: string | null;
  error_message: string | null;
  on_change: (settings: SubtitleDisplaySettings) => void;
  on_export: () => void;
};

export function SubtitleSettingsControl({
  settings,
  has_subtitles,
  settings_pending,
  export_pending,
  export_relative_path,
  error_message,
  on_change,
  on_export,
}: SubtitleSettingsControlProps) {
  const font_size_label_id = useId();
  const position_label_id = useId();
  const background_label_id = useId();
  const controls_disabled =
    !has_subtitles || settings_pending || export_pending;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Captions data-icon="inline-start" aria-hidden="true" />
          字幕
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] gap-4 p-4"
      >
        <PopoverHeader>
          <PopoverTitle>画面字幕</PopoverTitle>
          <PopoverDescription>
            {has_subtitles
              ? "调整会保存到当前视频，并同步用于带字幕导出。"
              : "完成字幕转写后即可调整显示并导出视频。"}
          </PopoverDescription>
        </PopoverHeader>

        <FieldGroup>
          <Field data-disabled={controls_disabled || undefined}>
            <FieldLabel id={font_size_label_id}>字号</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={settings.font_size}
              disabled={controls_disabled}
              aria-labelledby={font_size_label_id}
              onValueChange={(font_size) => {
                if (!font_size) return;
                on_change({
                  ...settings,
                  font_size: font_size as SubtitleFontSize,
                });
              }}
            >
              <ToggleGroupItem value="small">小</ToggleGroupItem>
              <ToggleGroupItem value="medium">中</ToggleGroupItem>
              <ToggleGroupItem value="large">大</ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field data-disabled={controls_disabled || undefined}>
            <FieldLabel id={position_label_id}>位置</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={settings.position}
              disabled={controls_disabled}
              aria-labelledby={position_label_id}
              onValueChange={(position) => {
                if (!position) return;
                on_change({
                  ...settings,
                  position: position as SubtitlePosition,
                });
              }}
            >
              <ToggleGroupItem value="bottom">底部</ToggleGroupItem>
              <ToggleGroupItem value="raised">抬高</ToggleGroupItem>
              <ToggleGroupItem value="center">居中</ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field data-disabled={controls_disabled || undefined}>
            <FieldLabel id={background_label_id}>底板</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={settings.background}
              disabled={controls_disabled}
              aria-labelledby={background_label_id}
              onValueChange={(background) => {
                if (!background) return;
                on_change({
                  ...settings,
                  background: background as SubtitleBackground,
                });
              }}
            >
              <ToggleGroupItem value="none">无</ToggleGroupItem>
              <ToggleGroupItem value="shadow">描边</ToggleGroupItem>
              <ToggleGroupItem value="solid">实底</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldGroup>

        <FieldDescription className="flex items-center gap-1.5">
          {settings_pending ? (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          ) : (
            <Check data-icon="inline-start" aria-hidden="true" />
          )}
          {settings_pending ? "正在保存到当前视频" : "已应用当前视频设置"}
        </FieldDescription>

        <Separator />

        <section
          className="flex flex-col gap-2"
          aria-labelledby="subtitle-export-title"
        >
          <div className="flex flex-col gap-0.5">
            <h3 id="subtitle-export-title" className="text-sm font-medium">
              带字幕导出
            </h3>
            <p className="text-sm text-muted-foreground">
              生成一份已烧录当前字幕样式的 MP4。
            </p>
          </div>
          <Button
            type="button"
            className="w-full"
            disabled={!has_subtitles || settings_pending || export_pending}
            onClick={on_export}
          >
            {export_pending ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Download data-icon="inline-start" aria-hidden="true" />
            )}
            {export_pending ? "正在导出" : "导出带字幕视频"}
          </Button>
          {export_relative_path ? (
            <p
              className="truncate text-xs text-muted-foreground"
              title={export_relative_path}
            >
              已保存：{export_relative_path}
            </p>
          ) : null}
        </section>

        {error_message ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{error_message}</AlertDescription>
          </Alert>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
