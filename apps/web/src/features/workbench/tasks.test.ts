import { describe, expect, it } from "vitest";

import { merge_task_record, type TaskRecord } from "@/features/workbench/tasks";

describe("merge_task_record", () => {
  it("keeps alternating progress updates ordered by creation time", () => {
    const older_task = task_record("job-older", "2026-08-25T08:00:00Z");
    const newer_task = task_record("job-newer", "2026-08-25T09:00:00Z");
    let tasks = merge_task_record([], older_task);
    tasks = merge_task_record(tasks, newer_task);

    tasks = merge_task_record(tasks, {
      ...older_task,
      progress_percent: 50,
    });
    tasks = merge_task_record(tasks, {
      ...newer_task,
      progress_percent: 60,
    });

    expect(tasks.map((task) => task.task_id)).toEqual([
      "job-newer",
      "job-older",
    ]);
  });

  it("does not move a task when its stage changes", () => {
    const older_task = task_record("job-older", "2026-08-25T08:00:00Z");
    const newer_task = task_record("job-newer", "2026-08-25T09:00:00Z");
    let tasks = merge_task_record([], older_task);
    tasks = merge_task_record(tasks, newer_task);

    for (const stage of ["pending", "downloading", "complete"]) {
      tasks = merge_task_record(tasks, { ...older_task, stage });
      expect(tasks.map((task) => task.task_id)).toEqual([
        "job-newer",
        "job-older",
      ]);
    }
  });

  it("uses descending task ids when creation times match", () => {
    const created_at = "2026-08-25T08:00:00Z";
    let tasks = merge_task_record([], task_record("job-a", created_at));
    tasks = merge_task_record(tasks, task_record("job-c", created_at));
    tasks = merge_task_record(tasks, task_record("job-b", created_at));

    expect(tasks.map((task) => task.task_id)).toEqual([
      "job-c",
      "job-b",
      "job-a",
    ]);
  });

  it("keeps only the newest 100 tasks", () => {
    let tasks: TaskRecord[] = [];
    for (let index = 0; index < 105; index += 1) {
      const created_at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      tasks = merge_task_record(
        tasks,
        task_record(`job-${index.toString().padStart(3, "0")}`, created_at),
      );
    }

    expect(tasks).toHaveLength(100);
    expect(tasks[0]?.task_id).toBe("job-104");
    expect(tasks.at(-1)?.task_id).toBe("job-005");
  });
});

function task_record(task_id: string, created_at: string): TaskRecord {
  return {
    task_id,
    task_type: "download",
    stage: "pending",
    message: "pending",
    progress_percent: 0,
    error_message: null,
    created_at,
  };
}
