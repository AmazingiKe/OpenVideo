import type { AnalysisJob, DownloadJob } from "../../shared/types";


type TaskDrawerProps = {
  open: boolean;
  download_jobs: DownloadJob[];
  analysis_job: AnalysisJob | null;
  on_toggle: () => void;
};

export function TaskDrawer({ open, download_jobs, analysis_job, on_toggle }: TaskDrawerProps) {
  const task_count = download_jobs.length + (analysis_job ? 1 : 0);
  return (
    <section className={open ? "task_drawer open" : "task_drawer"} aria-label="任务中心">
      <button className="task_drawer_toggle" type="button" onClick={on_toggle} aria-expanded={open}>
        <span>任务中心</span>
        <span>{task_count} 项</span>
      </button>
      {open ? (
        <div className="task_list">
          {download_jobs.map((job) => <TaskProgress key={job.job_id} name="下载" message={job.message} progress={job.progress_percent} error={job.error_message} />)}
          {analysis_job ? <TaskProgress name="分析" message={analysis_job.message} progress={analysis_job.progress_percent} error={analysis_job.error_message} /> : null}
          {task_count === 0 ? <p>暂无运行或最近的任务。</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function TaskProgress({
  name,
  message,
  progress,
  error,
}: {
  name: string;
  message: string;
  progress: number;
  error: string | null;
}) {
  const bounded_progress = Math.min(Math.max(progress, 0), 100);
  return (
    <article className="task_progress">
      <div><strong>{name}</strong><span>{message}</span><b>{bounded_progress.toFixed(0)}%</b></div>
      <div className="task_progress_track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bounded_progress}>
        <span style={{ width: `${bounded_progress}%` }} />
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}
