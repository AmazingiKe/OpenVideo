import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  get_transcript_version,
  list_transcript_versions,
  restore_transcript_version,
  type TranscriptVersion,
} from "@/shared/api/transcript_history";
import { error_message } from "@/shared/errors";
import { format_time } from "@/shared/format";
import type { Transcript } from "@/shared/types";

const PREVIEW_SEGMENT_LIMIT = 20;
const VERSION_REASONS = {
  replacement: "替换前",
  edit: "修改前",
  restore: "恢复前",
};

type TranscriptHistoryProps = {
  asset_id: string;
  disabled?: boolean;
  on_restored?: () => void;
};

export function TranscriptHistory({
  asset_id,
  disabled = false,
  on_restored,
}: TranscriptHistoryProps) {
  const [expanded, set_expanded] = useState(false);
  const [versions, set_versions] = useState<TranscriptVersion[] | null>(null);
  const [selected_id, set_selected_id] = useState("");
  const [preview, set_preview] = useState<{
    version_id: string;
    transcript: Transcript;
  } | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const [notice, set_notice] = useState("");
  const [restoring, set_restoring] = useState(false);
  const [revision, set_revision] = useState(0);
  const restore_controller = useRef<AbortController | null>(null);
  useEffect(() => () => restore_controller.current?.abort(), [asset_id]);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    set_versions(null);
    set_error(null);
    void list_transcript_versions(asset_id, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) set_versions(items);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) set_error(error_message(failure));
      });
    return () => controller.abort();
  }, [asset_id, expanded, revision]);
  useEffect(() => {
    if (!expanded || !selected_id) return;
    const controller = new AbortController();
    set_error(null);
    void get_transcript_version(asset_id, selected_id, controller.signal)
      .then((transcript) => {
        if (!controller.signal.aborted)
          set_preview({ version_id: selected_id, transcript });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) set_error(error_message(failure));
      });
    return () => controller.abort();
  }, [asset_id, expanded, selected_id, revision]);
  const selected_preview =
    preview?.version_id === selected_id ? preview.transcript : null;

  async function restore() {
    if (restoring || disabled || !selected_preview) return;
    const controller = new AbortController();
    restore_controller.current = controller;
    set_restoring(true);
    set_error(null);
    set_notice("");
    try {
      await restore_transcript_version(
        asset_id,
        selected_id,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      set_notice("已恢复字幕，恢复前的内容也已保存在历史中。");
      set_selected_id("");
      set_preview(null);
      set_revision((current) => current + 1);
      on_restored?.();
    } catch (failure) {
      if (!controller.signal.aborted) set_error(error_message(failure));
    } finally {
      if (!controller.signal.aborted) set_restoring(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="outline"
        aria-expanded={expanded}
        disabled={restoring}
        onClick={() => set_expanded((current) => !current)}
      >
        <History aria-hidden="true" />
        字幕历史
      </Button>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {expanded ? (
        <div className="flex flex-col gap-4" aria-label="字幕历史版本">
          <FieldDescription>
            显示最近 50 个版本。先预览再恢复，恢复前也会保存当前字幕。
          </FieldDescription>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {error}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => set_revision((current) => current + 1)}
                >
                  重试读取
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {!versions && !error ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner aria-hidden="true" />
              正在读取历史…
            </p>
          ) : null}
          {versions?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无历史版本。下次替换或修改字幕时会自动保存。
            </p>
          ) : null}
          {versions?.length ? (
            <Field>
              <FieldLabel htmlFor="transcript_history_version">
                历史版本
              </FieldLabel>
              <Select
                value={selected_id}
                onValueChange={set_selected_id}
                disabled={restoring}
              >
                <SelectTrigger
                  id="transcript_history_version"
                  className="w-full"
                >
                  <SelectValue placeholder="选择要预览的版本" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((version) => (
                    <SelectItem
                      key={version.version_id}
                      value={version.version_id}
                    >
                      {new Date(version.saved_at).toLocaleString()} ·{" "}
                      {VERSION_REASONS[version.reason]} ·{" "}
                      {version.segment_count} 段
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {selected_preview ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                预览前{" "}
                {Math.min(
                  selected_preview.segments.length,
                  PREVIEW_SEGMENT_LIMIT,
                )}{" "}
                / {selected_preview.segments.length} 段
              </p>
              <ol
                className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border p-4"
                aria-label="历史字幕预览"
              >
                {selected_preview.segments
                  .slice(0, PREVIEW_SEGMENT_LIMIT)
                  .map((segment, index) => (
                    <li key={index} className="text-sm break-words">
                      <span className="mr-2 text-xs text-muted-foreground">
                        {format_time(segment.start_seconds)}
                      </span>
                      {segment.text}
                    </li>
                  ))}
              </ol>
            </div>
          ) : selected_id && !error ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取预览…
            </p>
          ) : null}
          {versions?.length ? (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || restoring || !selected_preview}
              onClick={() => void restore()}
            >
              {restoring ? <Spinner aria-hidden="true" /> : null}
              {restoring ? "正在恢复…" : "恢复此版本"}
            </Button>
          ) : null}
          {disabled ? (
            <FieldDescription>请先停止当前转录，再恢复字幕。</FieldDescription>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
