import { type FormEvent, useEffect, useState } from "react";

import { use_task_manager } from "@/app/task_manager";
import { DownloadWorkspace } from "@/features/workbench/DownloadWorkspace";
import { get_health, probe_source } from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type { HealthResponse, ProbeEntry, ProbeResponse } from "@/shared/types";

export function DownloadsPage() {
  const { task_records, start_downloads } = use_task_manager();
  const [health, set_health] = useState<HealthResponse | null>(null);
  const [source_url, set_source_url] = useState("");
  const [probe_result, set_probe_result] = useState<ProbeResponse | null>(null);
  const [selected_urls, set_selected_urls] = useState<Set<string>>(new Set());
  const [is_submitting, set_is_submitting] = useState(false);
  const [page_error, set_page_error] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void get_health(controller.signal)
      .then(set_health)
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, []);

  async function submit_source_probe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized_url = source_url.trim();
    if (!normalized_url) {
      set_page_error("请先粘贴 Bilibili、抖音或 YouTube 视频地址");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      const probe = await probe_source(normalized_url);
      set_probe_result(probe);
      set_selected_urls(initial_selected_urls(probe.entries, normalized_url));
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_selected_downloads() {
    const urls = [...selected_urls];
    if (urls.length === 0) {
      set_page_error("请至少选择一个视频");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      const final_jobs = await start_downloads(urls);
      set_probe_result(null);
      set_selected_urls(new Set());
      if (final_jobs.some((job) => job.stage === "complete"))
        set_source_url("");
      const failed_job = final_jobs.find((job) => job.stage === "failed");
      if (failed_job)
        set_page_error(failed_job.error_message ?? "部分视频下载失败");
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  function toggle_url(url: string) {
    set_selected_urls((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <DownloadWorkspace
      health={health}
      task_records={task_records}
      source_url={source_url}
      probe_result={probe_result}
      selected_urls={selected_urls}
      current_source_video_id={source_video_id_from_url(source_url)}
      is_submitting={is_submitting}
      error={page_error}
      on_source_url_change={set_source_url}
      on_submit_probe={submit_source_probe}
      on_toggle_url={toggle_url}
      on_replace_selection={(urls) => set_selected_urls(new Set(urls))}
      on_start_download={() => void start_selected_downloads()}
    />
  );
}

function initial_selected_urls(
  entries: ProbeEntry[],
  source_url: string,
): Set<string> {
  const source_video_id = source_video_id_from_url(source_url);
  const current_entry = entries.find(
    (entry) => entry.source_video_id === source_video_id,
  );
  return current_entry ? new Set([current_entry.url]) : new Set();
}

function source_video_id_from_url(source_url: string): string | null {
  try {
    const url = new URL(source_url);
    const path_parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.endsWith("youtube.com")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return path_parts[0] ?? null;
    if (url.hostname.endsWith("bilibili.com") || url.hostname === "b23.tv")
      return path_parts.at(-1) ?? null;
    if (url.hostname.endsWith("douyin.com") && path_parts[0] === "video")
      return path_parts[1] ?? null;
  } catch {
    return null;
  }
  return null;
}
