import { useState } from "react";
import {
  CheckCircle2,
  Download,
  Grid2X2,
  List,
  ListVideo,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { folder_path_label } from "@/features/library/MoveToFolderDialog";
import { format_duration } from "@/shared/format";
import type {
  DownloadFolderSelection,
  DownloadQuality,
  LibraryFolder,
  ProbeEntry,
  ProbeResponse,
} from "@/shared/types";

const AUTOMATIC_FOLDER_VALUE = "__automatic__";
const UNCATEGORIZED_FOLDER_VALUE = "__uncategorized__";

const VIDEO_QUALITY_OPTIONS: Array<{
  value: DownloadQuality;
  label: string;
}> = [
  { value: "best", label: "最佳画质（推荐）" },
  { value: "2160p", label: "4K · 2160p" },
  { value: "1440p", label: "2K · 1440p" },
  { value: "1080p", label: "全高清 · 1080p" },
  { value: "720p", label: "高清 · 720p" },
  { value: "480p", label: "流畅 · 480p" },
];

type DownloadViewMode = "list" | "cards";

type DownloadSelectionProps = {
  probe_result: ProbeResponse;
  visible_entries: ProbeResponse["entries"];
  selected_urls: Set<string>;
  folders: LibraryFolder[];
  target_folder_id: DownloadFolderSelection;
  video_quality: DownloadQuality;
  current_source_video_id: string | null;
  current_entry_url: string | null;
  entry_filter: string;
  is_submitting: boolean;
  on_entry_filter_change: (value: string) => void;
  on_toggle_url: (url: string) => void;
  on_replace_selection: (urls: string[]) => void;
  on_target_folder_change: (folder_id: DownloadFolderSelection) => void;
  on_video_quality_change: (quality: DownloadQuality) => void;
  on_start_download: () => void;
};

export function DownloadSelection({
  probe_result,
  visible_entries,
  selected_urls,
  folders,
  target_folder_id,
  video_quality,
  current_source_video_id,
  current_entry_url,
  entry_filter,
  is_submitting,
  on_entry_filter_change,
  on_toggle_url,
  on_replace_selection,
  on_target_folder_change,
  on_video_quality_change,
  on_start_download,
}: DownloadSelectionProps) {
  const [view_mode, set_view_mode] = useState<DownloadViewMode>("list");
  const entry_numbers = new Map(
    probe_result.entries.map((entry, index) => [
      entry.source_video_id,
      index + 1,
    ]),
  );

  return (
    <>
      <Separator />
      <CardContent>
        <section
          className="flex flex-col gap-4"
          aria-labelledby="download_selection_title"
        >
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <ListVideo aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3
                  id="download_selection_title"
                  className="truncate font-semibold"
                  title={probe_result.title ?? "解析结果"}
                >
                  {probe_result.title ?? "解析结果"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {`共 ${probe_result.entries.length} 个视频，已选择 ${selected_urls.size} 个。`}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Field className="sm:w-64">
                <FieldLabel className="sr-only" htmlFor="download_entry_filter">
                  筛选视频标题
                </FieldLabel>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="download_entry_filter"
                    className="pl-9"
                    type="search"
                    value={entry_filter}
                    onChange={(event) =>
                      on_entry_filter_change(event.target.value)
                    }
                    placeholder="筛选标题"
                    disabled={is_submitting}
                  />
                </div>
              </Field>
              <ToggleGroup
                type="single"
                value={view_mode}
                onValueChange={(value) => {
                  if (value === "list" || value === "cards")
                    set_view_mode(value);
                }}
                variant="outline"
                size="sm"
                spacing={0}
                aria-label="视频列表显示方式"
              >
                <ToggleGroupItem value="list" aria-label="列表视图">
                  <List aria-hidden="true" />
                  列表
                </ToggleGroupItem>
                <ToggleGroupItem value="cards" aria-label="卡片视图">
                  <Grid2X2 aria-hidden="true" />
                  卡片
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2" aria-label="选集操作">
              {current_entry_url ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => on_replace_selection([current_entry_url])}
                  disabled={is_submitting}
                >
                  <CheckCircle2 data-icon="inline-start" />
                  当前视频
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  on_replace_selection(
                    probe_result.entries.map((entry) => entry.url),
                  )
                }
                disabled={is_submitting}
              >
                全选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => on_replace_selection([])}
                disabled={is_submitting || selected_urls.size === 0}
              >
                清空
              </Button>
            </div>
            <Badge variant="outline">{selected_urls.size} 个已选</Badge>
          </div>

          {visible_entries.length === 0 ? (
            <Empty className="min-h-48 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>没有匹配的视频</EmptyTitle>
                <EmptyDescription>换一个关键词试试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : view_mode === "list" ? (
            <DownloadEntryList
              entries={visible_entries}
              entry_numbers={entry_numbers}
              selected_urls={selected_urls}
              current_source_video_id={current_source_video_id}
              is_submitting={is_submitting}
              on_toggle_url={on_toggle_url}
            />
          ) : (
            <DownloadEntryCards
              entries={visible_entries}
              entry_numbers={entry_numbers}
              selected_urls={selected_urls}
              current_source_video_id={current_source_video_id}
              is_submitting={is_submitting}
              on_toggle_url={on_toggle_url}
            />
          )}
        </section>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-4 lg:flex-row lg:items-end">
        <FieldGroup className="grid flex-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="download_target_folder">目标文件夹</FieldLabel>
            <Select
              value={
                target_folder_id === undefined
                  ? AUTOMATIC_FOLDER_VALUE
                  : (target_folder_id ?? UNCATEGORIZED_FOLDER_VALUE)
              }
              onValueChange={(value) => {
                if (value === AUTOMATIC_FOLDER_VALUE) {
                  on_target_folder_change(undefined);
                } else {
                  on_target_folder_change(
                    value === UNCATEGORIZED_FOLDER_VALUE ? null : value,
                  );
                }
              }}
              disabled={is_submitting}
            >
              <SelectTrigger id="download_target_folder" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value={AUTOMATIC_FOLDER_VALUE}>
                    {probe_result.is_playlist
                      ? "自动分类（按合集名称）"
                      : "保持未分类"}
                  </SelectItem>
                  <SelectItem value={UNCATEGORIZED_FOLDER_VALUE}>
                    未分类
                  </SelectItem>
                  {folders.map((folder) => (
                    <SelectItem key={folder.folder_id} value={folder.folder_id}>
                      {folder_path_label(folder, folders)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="download_video_quality">视频清晰度</FieldLabel>
            <Select
              value={video_quality}
              onValueChange={(value) =>
                on_video_quality_change(value as DownloadQuality)
              }
              disabled={is_submitting}
            >
              <SelectTrigger id="download_video_quality" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  {VIDEO_QUALITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              平台没有对应规格时，将自动选择较低的可用清晰度。
            </FieldDescription>
          </Field>
        </FieldGroup>
        <Button
          className="shrink-0"
          type="button"
          onClick={on_start_download}
          disabled={is_submitting || selected_urls.size === 0}
        >
          <Download data-icon="inline-start" />
          下载 {selected_urls.size} 个视频
        </Button>
      </CardFooter>
    </>
  );
}

type DownloadEntryCollectionProps = {
  entries: ProbeEntry[];
  entry_numbers: Map<string, number>;
  selected_urls: Set<string>;
  current_source_video_id: string | null;
  is_submitting: boolean;
  on_toggle_url: (url: string) => void;
};

function DownloadEntryList({
  entries,
  entry_numbers,
  selected_urls,
  current_source_video_id,
  is_submitting,
  on_toggle_url,
}: DownloadEntryCollectionProps) {
  return (
    <ul
      className="max-h-96 overflow-auto rounded-lg border"
      aria-label="列表视图中的可下载视频"
    >
      {entries.map((entry) => {
        const checkbox_id = `download_list_entry_${entry.source_video_id}`;
        return (
          <li
            key={entry.source_video_id}
            className="border-b last:border-b-0 has-data-checked:bg-primary-subtle"
          >
            <label
              className="grid min-h-14 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover"
              htmlFor={checkbox_id}
            >
              <Checkbox
                id={checkbox_id}
                checked={selected_urls.has(entry.url)}
                onCheckedChange={() => on_toggle_url(entry.url)}
                disabled={is_submitting}
              />
              <span className="font-mono text-xs text-muted-foreground">
                {format_entry_number(entry_numbers.get(entry.source_video_id))}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <strong className="truncate text-sm font-medium">
                    {entry.title ?? entry.source_video_id}
                  </strong>
                  {entry.source_video_id === current_source_video_id ? (
                    <Badge className="shrink-0" variant="outline">
                      当前
                    </Badge>
                  ) : null}
                </span>
                {entry.uploader ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {entry.uploader}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {format_duration(entry.duration_seconds)}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function DownloadEntryCards({
  entries,
  entry_numbers,
  selected_urls,
  current_source_video_id,
  is_submitting,
  on_toggle_url,
}: DownloadEntryCollectionProps) {
  return (
    <ul
      className="grid max-h-[32rem] gap-3 overflow-auto sm:grid-cols-2 xl:grid-cols-3"
      aria-label="卡片视图中的可下载视频"
    >
      {entries.map((entry) => {
        const checkbox_id = `download_card_entry_${entry.source_video_id}`;
        return (
          <li key={entry.source_video_id}>
            <label
              className="flex min-h-36 cursor-pointer flex-col gap-4 rounded-lg border bg-surface-subtle p-4 transition-colors hover:bg-surface-hover has-data-checked:border-primary has-data-checked:bg-primary-subtle"
              htmlFor={checkbox_id}
            >
              <span className="flex items-center justify-between gap-3">
                <Checkbox
                  id={checkbox_id}
                  checked={selected_urls.has(entry.url)}
                  onCheckedChange={() => on_toggle_url(entry.url)}
                  disabled={is_submitting}
                />
                <span className="font-mono text-xs text-muted-foreground">
                  {format_entry_number(
                    entry_numbers.get(entry.source_video_id),
                  )}
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <strong className="line-clamp-2 text-sm font-medium">
                  {entry.title ?? entry.source_video_id}
                </strong>
                {entry.uploader ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {entry.uploader}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {format_duration(entry.duration_seconds)}
                </span>
                {entry.source_video_id === current_source_video_id ? (
                  <Badge variant="outline">当前</Badge>
                ) : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function format_entry_number(entry_number: number | undefined): string {
  return String(entry_number ?? 0).padStart(2, "0");
}
