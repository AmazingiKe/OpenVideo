import type { FormEvent } from "react";
import { Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MARKER_IMPORTANCE_VALUES } from "@/shared/marker_labels";
import type { MarkerImportance } from "@/shared/types";
import { MARKER_SHAPE_VALUES } from "./media_timeline_calculations";

const MARKER_EDITOR_OFFSET = 8;
const MARKER_EDITOR_COLLISION_PADDING = 8;
const DEFAULT_MARKER_DURATION_SECONDS = 5;

type MediaTimelineMarkerEditorProps = {
  editing_marker_id: string | null;
  marker_editor_position: { x: number; y: number } | null;
  duration: number;
  marker_start_draft: number;
  marker_end_draft: number | null;
  marker_content_draft: string;
  marker_importance_draft: MarkerImportance;
  marker_save_error: string | null;
  is_saving_marker: boolean;
  set_marker_start_draft: (value: number) => void;
  set_marker_end_draft: (value: number | null) => void;
  set_marker_content_draft: (value: string) => void;
  set_marker_importance_draft: (value: MarkerImportance) => void;
  cancel_marker_edit: () => void;
  save_marker: (event: FormEvent<HTMLFormElement>) => void;
  delete_marker: () => void;
};

export function MediaTimelineMarkerEditor({
  editing_marker_id,
  marker_editor_position,
  duration,
  marker_start_draft,
  marker_end_draft,
  marker_content_draft,
  marker_importance_draft,
  marker_save_error,
  is_saving_marker,
  set_marker_start_draft,
  set_marker_end_draft,
  set_marker_content_draft,
  set_marker_importance_draft,
  cancel_marker_edit,
  save_marker,
  delete_marker,
}: MediaTimelineMarkerEditorProps) {
  return (
    <Popover
      open={editing_marker_id !== null}
      onOpenChange={(open) => {
        if (!open && !is_saving_marker) cancel_marker_edit();
      }}
    >
      {marker_editor_position ? (
        <PopoverAnchor asChild>
          <span
            className="timeline_marker_editor_anchor pointer-events-none fixed size-px"
            style={{
              left: marker_editor_position.x,
              top: marker_editor_position.y,
            }}
            aria-hidden
          />
        </PopoverAnchor>
      ) : null}
      <PopoverContent
        aria-labelledby="marker-editor-title"
        aria-describedby="marker-editor-description"
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(30rem,calc(100vw-1rem))] overflow-y-auto p-4"
        side="bottom"
        align="start"
        sideOffset={MARKER_EDITOR_OFFSET}
        collisionPadding={MARKER_EDITOR_COLLISION_PADDING}
      >
        <PopoverHeader>
          <PopoverTitle id="marker-editor-title">编辑标记</PopoverTitle>
          <PopoverDescription id="marker-editor-description">
            记录这段视频的内容，也可以单独设置重要程度。
          </PopoverDescription>
        </PopoverHeader>
        <form className="flex flex-col gap-4" onSubmit={save_marker}>
          <FieldGroup>
            <Field data-disabled={is_saving_marker || undefined}>
              <FieldLabel htmlFor="marker-content">标记内容</FieldLabel>
              <Textarea
                id="marker-content"
                autoFocus
                rows={4}
                placeholder="这段视频讲了什么，或有哪些值得关注的内容？"
                value={marker_content_draft}
                onChange={(event) =>
                  set_marker_content_draft(event.currentTarget.value)
                }
                disabled={is_saving_marker}
              />
            </Field>
            <Field data-disabled={is_saving_marker || undefined}>
              <FieldLabel id="marker-importance-label">重要程度</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="flex-wrap"
                value={String(marker_importance_draft)}
                onValueChange={(value) =>
                  set_marker_importance_draft(Number(value) as MarkerImportance)
                }
                disabled={is_saving_marker}
                aria-labelledby="marker-importance-label"
                aria-describedby="marker-importance-description"
              >
                {MARKER_IMPORTANCE_VALUES.map((importance) => (
                  <ToggleGroupItem key={importance} value={String(importance)}>
                    {importance === 0 ? "未评分" : `${importance} 星`}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription id="marker-importance-description">
                内容和评分可单独填写；两者都留空时，AI 按 1 星理解。
              </FieldDescription>
            </Field>
          </FieldGroup>
          <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="marker-start">开始时间（秒）</FieldLabel>
              <Input
                id="marker-start"
                type="number"
                min={0}
                max={duration}
                step="any"
                value={marker_start_draft}
                onChange={(event) =>
                  set_marker_start_draft(event.currentTarget.valueAsNumber)
                }
                disabled={is_saving_marker}
              />
            </Field>
            {marker_end_draft !== null ? (
              <Field
                data-invalid={
                  marker_end_draft <= marker_start_draft || undefined
                }
              >
                <FieldLabel htmlFor="marker-end">结束时间（秒）</FieldLabel>
                <Input
                  id="marker-end"
                  type="number"
                  min={marker_start_draft}
                  max={duration}
                  step="any"
                  value={marker_end_draft}
                  aria-invalid={marker_end_draft <= marker_start_draft}
                  onChange={(event) =>
                    set_marker_end_draft(event.currentTarget.valueAsNumber)
                  }
                  disabled={is_saving_marker}
                />
                {marker_end_draft <= marker_start_draft ? (
                  <FieldDescription>
                    结束时间必须晚于开始时间。
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
          </FieldGroup>
          <Field className="flex-row items-center justify-between">
            <FieldLabel id="marker-shape-label">标记形态</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={
                marker_end_draft === null
                  ? MARKER_SHAPE_VALUES.point
                  : MARKER_SHAPE_VALUES.range
              }
              onValueChange={(value) => {
                if (!value) return;
                set_marker_end_draft(
                  value === MARKER_SHAPE_VALUES.range
                    ? Math.min(
                        duration,
                        marker_start_draft + DEFAULT_MARKER_DURATION_SECONDS,
                      )
                    : null,
                );
              }}
              disabled={is_saving_marker}
              aria-labelledby="marker-shape-label"
            >
              <ToggleGroupItem value={MARKER_SHAPE_VALUES.point}>
                点标记
              </ToggleGroupItem>
              <ToggleGroupItem value={MARKER_SHAPE_VALUES.range}>
                范围标记
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {marker_save_error ? (
            <Alert variant="destructive">
              <AlertDescription>{marker_save_error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={is_saving_marker}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>删除这个标记？</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除后无法恢复，内容、评分和范围信息也会一并移除。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={delete_marker}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    删除标记
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={cancel_marker_edit}
                disabled={is_saving_marker}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  is_saving_marker ||
                  !Number.isFinite(marker_start_draft) ||
                  (marker_end_draft !== null &&
                    (!Number.isFinite(marker_end_draft) ||
                      marker_end_draft <= marker_start_draft))
                }
              >
                {is_saving_marker ? <Spinner data-icon="inline-start" /> : null}
                {is_saving_marker ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
