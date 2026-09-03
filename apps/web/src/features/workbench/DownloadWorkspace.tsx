import { type FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Link2,
  Search,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import { DownloadAccountsCard } from "@/features/downloads/DownloadAccountsCard";
import { DownloadSelection } from "@/features/downloads/DownloadSelection";
import type {
  DownloadAccount,
  DownloadCookieBrowser,
  DownloadFolderSelection,
  DownloadQuality,
  HealthResponse,
  LibraryFolder,
  ProbeResponse,
  SourcePlatform,
} from "@/shared/types";

type DownloadWorkspaceProps = {
  health: HealthResponse | null;
  source_url: string;
  probe_result: ProbeResponse | null;
  selected_urls: Set<string>;
  folders: LibraryFolder[];
  target_folder_id: DownloadFolderSelection;
  video_quality: DownloadQuality;
  current_source_video_id: string | null;
  is_submitting: boolean;
  error: string | null;
  download_accounts: DownloadAccount[];
  account_loading_platform: SourcePlatform | null;
  account_errors: Partial<Record<SourcePlatform, string>>;
  on_source_url_change: (value: string) => void;
  on_submit_probe: (event: FormEvent<HTMLFormElement>) => void;
  on_toggle_url: (url: string) => void;
  on_replace_selection: (urls: string[]) => void;
  on_target_folder_change: (folder_id: DownloadFolderSelection) => void;
  on_video_quality_change: (quality: DownloadQuality) => void;
  on_start_download: () => void;
  on_save_download_account: (
    platform: SourcePlatform,
    cookie: string,
  ) => Promise<void>;
  on_login_download_account: (platform: SourcePlatform) => Promise<void>;
  on_cancel_download_account_login: (platform: SourcePlatform) => Promise<void>;
  on_import_download_account: (
    platform: SourcePlatform,
    browser: DownloadCookieBrowser,
  ) => Promise<void>;
  on_test_download_account: (platform: SourcePlatform) => Promise<void>;
  on_disconnect_download_account: (platform: SourcePlatform) => Promise<void>;
};

export function DownloadWorkspace({
  health,
  source_url,
  probe_result,
  selected_urls,
  folders,
  target_folder_id,
  video_quality,
  current_source_video_id,
  is_submitting,
  error,
  download_accounts,
  account_loading_platform,
  account_errors,
  on_source_url_change,
  on_submit_probe,
  on_toggle_url,
  on_replace_selection,
  on_target_folder_change,
  on_video_quality_change,
  on_start_download,
  on_save_download_account,
  on_login_download_account,
  on_cancel_download_account_login,
  on_import_download_account,
  on_test_download_account,
  on_disconnect_download_account,
}: DownloadWorkspaceProps) {
  const dependencies_ready = Boolean(
    health?.dependencies.yt_dlp && health.dependencies.ffmpeg,
  );
  const status_label = !health
    ? "检查环境中"
    : dependencies_ready
      ? "下载服务正常"
      : "下载服务未就绪";
  const [entry_filter, set_entry_filter] = useState("");

  useEffect(() => set_entry_filter(""), [probe_result]);

  const normalized_filter = entry_filter.trim().toLocaleLowerCase();
  const visible_entries =
    probe_result?.entries.filter(
      (entry) =>
        !normalized_filter ||
        (entry.title ?? entry.source_video_id)
          .toLocaleLowerCase()
          .includes(normalized_filter),
    ) ?? [];
  const current_entry =
    probe_result?.entries.find(
      (entry) => entry.source_video_id === current_source_video_id,
    ) ?? null;

  return (
    <section
      className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="download_workspace_title"
    >
      <PageHeader
        title_id="download_workspace_title"
        eyebrow="视频下载"
        title="下载在线视频，稍后集中处理"
        description="解析视频或播放列表，选择内容和清晰度后加入后台任务队列。"
        icon={Download}
        action={
          <Badge variant={dependencies_ready ? "secondary" : "outline"}>
            {health ? (
              <CheckCircle2 data-icon="inline-start" />
            ) : (
              <Spinner data-icon="inline-start" />
            )}
            {status_label}
          </Badge>
        }
      />
      <DownloadAccountsCard
        accounts={download_accounts}
        loading_platform={account_loading_platform}
        errors={account_errors}
        on_save={on_save_download_account}
        on_login={on_login_download_account}
        on_cancel_login={on_cancel_download_account_login}
        on_import_browser={on_import_download_account}
        on_test={on_test_download_account}
        on_disconnect={on_disconnect_download_account}
      />
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary-muted text-primary">
              <Link2 aria-hidden="true" />
            </div>
            <div>
              <CardTitle role="heading" aria-level={2}>
                解析视频链接
              </CardTitle>
              <CardDescription>
                粘贴链接，解析后选择要下载的内容。
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant="secondary">解析与下载</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form onSubmit={on_submit_probe}>
            <FieldGroup>
              <Field data-disabled={is_submitting || !dependencies_ready}>
                <FieldLabel htmlFor="source_url">视频或播放列表地址</FieldLabel>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="source_url"
                    className="min-w-0 flex-1"
                    type="url"
                    value={source_url}
                    onChange={(event) =>
                      on_source_url_change(event.target.value)
                    }
                    placeholder="https://www.bilibili.com/video/..."
                    disabled={is_submitting}
                    aria-invalid={Boolean(error)}
                  />
                  <Button
                    type="submit"
                    disabled={is_submitting || !dependencies_ready}
                  >
                    {is_submitting ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <Search data-icon="inline-start" />
                    )}
                    {is_submitting ? "正在解析" : "解析链接"}
                  </Button>
                </div>
                <FieldDescription>
                  支持公开可访问的单集、合集与播放列表链接。
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error ? (
              <Alert className="mt-4" variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>无法解析此链接</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        </CardContent>
        {probe_result ? (
          <DownloadSelection
            probe_result={probe_result}
            visible_entries={visible_entries}
            selected_urls={selected_urls}
            folders={folders}
            target_folder_id={target_folder_id}
            video_quality={video_quality}
            current_source_video_id={current_source_video_id}
            current_entry_url={current_entry?.url ?? null}
            entry_filter={entry_filter}
            is_submitting={is_submitting}
            on_entry_filter_change={set_entry_filter}
            on_toggle_url={on_toggle_url}
            on_replace_selection={on_replace_selection}
            on_target_folder_change={on_target_folder_change}
            on_video_quality_change={on_video_quality_change}
            on_start_download={on_start_download}
          />
        ) : null}
      </Card>
    </section>
  );
}
