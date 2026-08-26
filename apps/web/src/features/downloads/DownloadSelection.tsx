import { CheckCircle2, Download, ListVideo, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { folder_path_label } from "@/features/library/MoveToFolderDialog";
import { format_duration } from "@/shared/format";
import type {
  DownloadFolderSelection,
  LibraryFolder,
  ProbeResponse,
} from "@/shared/types";

const AUTOMATIC_FOLDER_VALUE = "__automatic__";
const UNCATEGORIZED_FOLDER_VALUE = "__uncategorized__";

type DownloadSelectionProps = {
  probe_result: ProbeResponse;
  visible_entries: ProbeResponse["entries"];
  selected_urls: Set<string>;
  folders: LibraryFolder[];
  target_folder_id: DownloadFolderSelection;
  current_source_video_id: string | null;
  current_entry_url: string | null;
  entry_filter: string;
  is_submitting: boolean;
  on_entry_filter_change: (value: string) => void;
  on_toggle_url: (url: string) => void;
  on_replace_selection: (urls: string[]) => void;
  on_target_folder_change: (folder_id: DownloadFolderSelection) => void;
  on_start_download: () => void;
};

export function DownloadSelection({
  probe_result,
  visible_entries,
  selected_urls,
  folders,
  target_folder_id,
  current_source_video_id,
  current_entry_url,
  entry_filter,
  is_submitting,
  on_entry_filter_change,
  on_toggle_url,
  on_replace_selection,
  on_target_folder_change,
  on_start_download,
}: DownloadSelectionProps) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
            <ListVideo aria-hidden="true" />
          </div>
          <div>
            <CardTitle role="heading" aria-level={2}>
              {probe_result.title ?? "检测结果"}
            </CardTitle>
            <CardDescription>
              共 {probe_result.entries.length} 个视频，选择后加入下载队列。
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge>{selected_urls.size} 个已选</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
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
          <div className="relative w-full md:w-64">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="pl-9"
              type="search"
              value={entry_filter}
              onChange={(event) => on_entry_filter_change(event.target.value)}
              placeholder="筛选标题"
              aria-label="筛选视频标题"
              disabled={is_submitting}
            />
          </div>
        </div>
        <ul
          className="max-h-96 overflow-auto rounded-lg border"
          aria-label="可下载视频列表"
        >
          {visible_entries.map((entry) => {
            const entry_number = probe_result.entries.indexOf(entry) + 1;
            const is_current =
              entry.source_video_id === current_source_video_id;
            const checkbox_id = `download_entry_${entry.source_video_id}`;
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
                    {String(entry_number).padStart(2, "0")}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-sm font-medium">
                      {entry.title ?? entry.source_video_id}
                    </strong>
                    {is_current ? (
                      <Badge className="shrink-0" variant="outline">
                        当前
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {format_duration(entry.duration_seconds)}
                  </span>
                </label>
              </li>
            );
          })}
          {visible_entries.length === 0 ? (
            <li>
              <Empty className="min-h-40 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>没有匹配的视频</EmptyTitle>
                  <EmptyDescription>换一个关键词试试。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </li>
          ) : null}
        </ul>
      </CardContent>
      <CardFooter className="justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm text-muted-foreground">目标文件夹</p>
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
            <SelectTrigger
              className="w-full sm:w-64"
              aria-label="下载目标文件夹"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectGroup>
                <SelectItem value={AUTOMATIC_FOLDER_VALUE}>
                  自动分类（按合集名称）
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
        </div>
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
    </Card>
  );
}
