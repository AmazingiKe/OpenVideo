import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Download,
  FileText,
  ScanSearch,
  Settings as SettingsIcon,
} from "lucide-react";

import {
  analyze_asset,
  create_download,
  get_health,
  get_segments,
  get_transcript,
  list_assets,
  probe_source,
  transcribe_asset,
  update_transcript_segment,
  type ApiError,
} from "./shared/api";
import { poll_analysis } from "./shared/poll_analysis";
import { poll_download } from "./shared/poll_download";
import type {
  AnalysisJob,
  AnalysisMode,
  DownloadJob,
  HealthResponse,
  MediaAsset,
  MediaSegment,
  ProbeEntry,
  ProbeResponse,
  Transcript,
} from "./shared/types";
import { use_asset_markers } from "./features/player/use_asset_markers";
import { type PlayerHandle } from "./features/player/Player";
import { AssetLibrary } from "./features/workbench/AssetLibrary";
import { AnalysisTimeline } from "./features/workbench/AnalysisTimeline";
import { DownloadWorkspace } from "./features/workbench/DownloadWorkspace";
import { SummaryWorkspace } from "./features/workbench/SummaryWorkspace";
import { type TaskRecord } from "./features/workbench/tasks";
import { VideoWorkspace } from "./features/workbench/VideoWorkspace";
import { SettingsPage } from "./features/settings/SettingsPage";

const terminal_download_stages = new Set(["complete", "failed"]);
const MAX_TASK_RECORDS = 100;
const WORKSPACE_MODULES = [
  { id: "download", label: "下载", path: "/downloads", icon: Download },
  { id: "analysis", label: "分析", path: "/analysis", icon: ScanSearch },
  { id: "summary", label: "总结", path: "/summary", icon: FileText },
] as const;

type WorkspaceModule = (typeof WORKSPACE_MODULES)[number];
type WorkspaceModuleId = WorkspaceModule["id"];
type ActivePage = WorkspaceModuleId | "settings";

function active_page_from_path(pathname: string): ActivePage {
  if (pathname === "/settings") return "settings";
  return (
    WORKSPACE_MODULES.find((module) => module.path === pathname)?.id ??
    "download"
  );
}

export function App() {
  const [health, set_health] = useState<HealthResponse | null>(null);
  const [assets, set_assets] = useState<MediaAsset[]>([]);
  const [selected_asset_id, set_selected_asset_id] = useState<string | null>(
    null,
  );
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [segments, set_segments] = useState<MediaSegment[]>([]);
  const [transcript, set_transcript] = useState<Transcript | null>(null);
  const [current_time, set_current_time] = useState(0);
  const [source_url, set_source_url] = useState("");
  const [probe_result, set_probe_result] = useState<ProbeResponse | null>(null);
  const [selected_probe_urls, set_selected_probe_urls] = useState<Set<string>>(
    new Set(),
  );
  const [is_submitting, set_is_submitting] = useState(false);
  const [is_analyzing, set_is_analyzing] = useState(false);
  const [is_transcribing, set_is_transcribing] = useState(false);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [active_page, set_active_page] = useState<ActivePage>(() =>
    active_page_from_path(window.location.pathname),
  );
  const player_ref = useRef<PlayerHandle>(null);
  const download_controller_ref = useRef<AbortController | null>(null);
  const analysis_controller_ref = useRef<AbortController | null>(null);

  const selected_asset =
    assets.find((asset) => asset.asset_id === selected_asset_id) ?? null;
  const {
    markers,
    marker_error,
    add_marker,
    update_marker_tags,
    remove_marker,
  } = use_asset_markers(selected_asset?.asset_id ?? "");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      get_health(controller.signal),
      refresh_assets(controller.signal),
    ])
      .then(([next_health]) => set_health(next_health))
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      download_controller_ref.current?.abort();
      analysis_controller_ref.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const current_path = window.location.pathname;
    const has_current_page =
      current_path === "/settings" ||
      WORKSPACE_MODULES.some((module) => module.path === current_path);
    if (!has_current_page) window.history.replaceState(null, "", "/downloads");

    function sync_active_page() {
      set_active_page(active_page_from_path(window.location.pathname));
    }

    window.addEventListener("popstate", sync_active_page);
    return () => window.removeEventListener("popstate", sync_active_page);
  }, []);

  useEffect(() => {
    set_current_time(0);
  }, [selected_asset_id]);

  useEffect(() => {
    if (!selected_asset_id) {
      set_segments([]);
      set_transcript(null);
      return;
    }
    const controller = new AbortController();
    void load_asset_analysis(selected_asset_id, controller.signal)
      .then(({ loaded_segments, loaded_transcript }) => {
        set_segments(loaded_segments);
        set_transcript(loaded_transcript);
      })
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, [selected_asset_id]);

  async function refresh_assets(signal?: AbortSignal) {
    const next_assets = await list_assets(signal);
    set_assets(next_assets);
    set_selected_asset_id((current_id) => {
      if (
        current_id &&
        next_assets.some((asset) => asset.asset_id === current_id)
      )
        return current_id;
      return (
        next_assets.find((asset) => asset.status === "ready")?.asset_id ?? null
      );
    });
  }

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
      set_selected_probe_urls(
        initial_selected_probe_urls(probe.entries, normalized_url),
      );
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_selected_downloads() {
    const urls = [...selected_probe_urls];
    if (urls.length === 0) {
      set_page_error("请至少选择一个视频");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      await start_downloads(urls);
      set_probe_result(null);
      set_selected_probe_urls(new Set());
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_downloads(urls: string[]) {
    download_controller_ref.current?.abort();
    const controller = new AbortController();
    download_controller_ref.current = controller;
    const jobs = await create_download(urls, controller.signal);
    jobs.forEach(record_download_job);
    const final_jobs = await Promise.all(
      jobs.map((job) =>
        terminal_download_stages.has(job.stage)
          ? Promise.resolve(job)
          : poll_download(job, record_download_job, controller.signal),
      ),
    );
    final_jobs.forEach(record_download_job);
    const completed_jobs = final_jobs.filter((job) => job.stage === "complete");
    const failed_job = final_jobs.find((job) => job.stage === "failed");
    if (completed_jobs.length > 0) {
      await refresh_assets(controller.signal);
      set_selected_asset_id(completed_jobs[completed_jobs.length - 1].asset_id);
      set_source_url("");
    }
    if (failed_job)
      set_page_error(failed_job.error_message ?? "部分视频下载失败");
    if (download_controller_ref.current === controller)
      download_controller_ref.current = null;
  }

  async function start_analysis(mode: AnalysisMode, marker_ids: string[]) {
    if (!selected_asset_id) return;
    analysis_controller_ref.current?.abort();
    const controller = new AbortController();
    analysis_controller_ref.current = controller;
    set_is_analyzing(true);
    set_page_error(null);
    try {
      const job = await analyze_asset(
        selected_asset_id,
        mode,
        marker_ids,
        controller.signal,
      );
      record_analysis_job(job);
      const final_job =
        job.stage === "complete"
          ? job
          : await poll_analysis(job, record_analysis_job, controller.signal);
      if (final_job.stage === "failed") {
        set_page_error(final_job.error_message ?? "分析失败");
        return;
      }
      const loaded_analysis = await load_asset_analysis(
        selected_asset_id,
        controller.signal,
      );
      set_segments(loaded_analysis.loaded_segments);
      set_transcript(loaded_analysis.loaded_transcript);
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_analyzing(false);
      if (analysis_controller_ref.current === controller)
        analysis_controller_ref.current = null;
    }
  }

  function record_download_job(job: DownloadJob) {
    record_task({
      task_id: job.job_id,
      task_type: "download",
      stage: job.stage,
      message: job.message,
      progress_percent: job.progress_percent,
      error_message: job.error_message,
    });
  }

  function record_analysis_job(job: AnalysisJob) {
    record_task({
      task_id: job.job_id,
      task_type: "analysis",
      stage: job.stage,
      message: job.message,
      progress_percent: job.progress_percent,
      error_message: job.error_message,
    });
  }

  function record_task(task: TaskRecord) {
    set_task_records((current) => {
      const previous_task = current.find(
        (item) => item.task_id === task.task_id,
      );
      const remaining_tasks = current.filter(
        (item) => item.task_id !== task.task_id,
      );
      const next_tasks = previous_task
        ? [task, ...remaining_tasks]
        : [task, ...current];
      return next_tasks.slice(0, MAX_TASK_RECORDS);
    });
  }

  async function start_transcription() {
    if (!selected_asset_id) return;
    analysis_controller_ref.current?.abort();
    const controller = new AbortController();
    analysis_controller_ref.current = controller;
    set_is_transcribing(true);
    set_page_error(null);
    try {
      const job = await transcribe_asset(selected_asset_id, controller.signal);
      record_analysis_job(job);
      const final_job =
        job.stage === "complete"
          ? job
          : await poll_analysis(job, record_analysis_job, controller.signal);
      if (final_job.stage === "failed") {
        set_page_error(final_job.error_message ?? "转录失败");
        return;
      }
      set_transcript(
        await get_transcript(selected_asset_id, controller.signal),
      );
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_transcribing(false);
      if (analysis_controller_ref.current === controller)
        analysis_controller_ref.current = null;
    }
  }

  async function save_transcript_segment(segment_index: number, text: string) {
    if (!selected_asset_id) return;
    set_page_error(null);
    try {
      const updated_transcript = await update_transcript_segment(
        selected_asset_id,
        segment_index,
        text,
      );
      set_transcript(updated_transcript);
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
      throw error;
    }
  }

  function seek_player(seconds: number) {
    set_current_time(seconds);
    player_ref.current?.seek_to(seconds);
  }

  function navigate_to_workspace_module(module: WorkspaceModule) {
    if (window.location.pathname !== module.path)
      window.history.pushState(null, "", module.path);
    set_active_page(module.id);
  }

  function navigate_to_settings() {
    if (window.location.pathname !== "/settings")
      window.history.pushState(null, "", "/settings");
    set_active_page("settings");
  }

  return (
    <div className="workbench_shell">
      <header className="workbench_header">
        <div className="workbench_brand">
          <Clapperboard aria-hidden="true" />
          <strong>OpenVideo</strong>
        </div>
        <nav className="workbench_navigation" aria-label="工作区导航">
          {WORKSPACE_MODULES.map((module) => (
            <WorkspaceNavigationLink
              key={module.id}
              module={module}
              active={active_page === module.id}
              on_navigate={navigate_to_workspace_module}
            />
          ))}
        </nav>
        <a
          className={
            active_page === "settings"
              ? "topbar_settings_link active"
              : "topbar_settings_link"
          }
          href="/settings"
          aria-label="设置"
          aria-current={active_page === "settings" ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            navigate_to_settings();
          }}
        >
          <SettingsIcon aria-hidden="true" />
        </a>
      </header>
      <main
        className={
          active_page === "analysis" ? "workbench_main" : "module_main"
        }
      >
        {active_page === "download" ? (
          <DownloadWorkspace
            health={health}
            task_records={task_records}
            source_url={source_url}
            probe_result={probe_result}
            selected_urls={selected_probe_urls}
            current_source_video_id={source_video_id_from_url(source_url)}
            is_submitting={is_submitting}
            error={page_error}
            on_source_url_change={set_source_url}
            on_submit_probe={submit_source_probe}
            on_toggle_url={(url) =>
              set_selected_probe_urls((current) => {
                const next = new Set(current);
                if (next.has(url)) next.delete(url);
                else next.add(url);
                return next;
              })
            }
            on_replace_selection={(urls) =>
              set_selected_probe_urls(new Set(urls))
            }
            on_start_download={() => void start_selected_downloads()}
          />
        ) : null}
        {active_page === "analysis" ? (
          <>
            <AssetLibrary
              assets={assets}
              selected_asset_id={selected_asset_id}
              on_select={set_selected_asset_id}
            />
            <VideoWorkspace
              asset={selected_asset}
              markers={markers}
              transcript={transcript}
              player_ref={player_ref}
              on_time_change={set_current_time}
              has_transcript={transcript !== null}
              is_transcribing={is_transcribing}
              on_start_transcription={() => void start_transcription()}
              is_analyzing={is_analyzing}
              on_start_analysis={(mode, marker_ids) =>
                void start_analysis(mode, marker_ids)
              }
            />
            <AnalysisTimeline
              duration_seconds={selected_asset?.duration_seconds ?? null}
              current_time={current_time}
              transcript={transcript}
              segments={segments}
              markers={markers}
              marker_error={marker_error}
              on_seek={seek_player}
              on_add_marker={(seconds) => add_marker(seconds)}
              on_remove_marker={(marker_id) => remove_marker(marker_id)}
              on_update_marker_tags={(marker_id, tags) =>
                update_marker_tags(marker_id, tags)
              }
              on_update_transcript={(segment_index, text) =>
                save_transcript_segment(segment_index, text)
              }
            />
          </>
        ) : null}
        {active_page === "summary" ? (
          <SummaryWorkspace
            selected_asset={selected_asset}
            segments={segments}
            transcript={transcript}
          />
        ) : null}
        {active_page === "settings" ? <SettingsPage /> : null}
      </main>
      {page_error &&
      active_page !== "download" &&
      active_page !== "settings" ? (
        <p className="workbench_error" role="alert">
          {page_error}
        </p>
      ) : null}
    </div>
  );
}

function initial_selected_probe_urls(
  entries: ProbeEntry[],
  source_url: string,
): Set<string> {
  const current_source_video_id = source_video_id_from_url(source_url);
  const current_entry = entries.find(
    (entry) => entry.source_video_id === current_source_video_id,
  );
  return current_entry ? new Set([current_entry.url]) : new Set();
}

function source_video_id_from_url(source_url: string): string | null {
  try {
    const url = new URL(source_url);
    const path_parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.endsWith("youtube.com")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return path_parts[0] ?? null;
    if (url.hostname.endsWith("bilibili.com") || url.hostname === "b23.tv") {
      return path_parts.at(-1) ?? null;
    }
    if (url.hostname.endsWith("douyin.com") && path_parts[0] === "video")
      return path_parts[1] ?? null;
  } catch {
    return null;
  }
  return null;
}

type WorkspaceNavigationLinkProps = {
  module: WorkspaceModule;
  active: boolean;
  on_navigate: (module: WorkspaceModule) => void;
};

function WorkspaceNavigationLink({
  module,
  active,
  on_navigate,
}: WorkspaceNavigationLinkProps) {
  const ModuleIcon = module.icon;
  return (
    <a
      href={module.path}
      className={active ? "active" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        on_navigate(module);
      }}
    >
      <ModuleIcon aria-hidden="true" />
      {module.label}
    </a>
  );
}

async function load_asset_analysis(asset_id: string, signal: AbortSignal) {
  const [loaded_segments, loaded_transcript] = await Promise.all([
    load_optional_segments(asset_id, signal),
    load_optional_transcript(asset_id, signal),
  ]);
  return { loaded_segments, loaded_transcript };
}

async function load_optional_segments(
  asset_id: string,
  signal: AbortSignal,
): Promise<MediaSegment[]> {
  try {
    return await get_segments(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return [];
    throw error;
  }
}

async function load_optional_transcript(
  asset_id: string,
  signal: AbortSignal,
): Promise<Transcript | null> {
  try {
    return await get_transcript(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return null;
    throw error;
  }
}

function error_message(error: unknown): string {
  if (is_abort_error(error)) return "请求已取消";
  if (is_api_error(error) || error instanceof Error) return error.message;
  return "发生了未知错误";
}

function is_api_error(error: unknown): error is ApiError {
  return error instanceof Error && "status" in error;
}

function is_not_found_error(error: unknown): error is ApiError {
  return is_api_error(error) && error.status === 404;
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
