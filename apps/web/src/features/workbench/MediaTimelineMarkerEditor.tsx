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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MARKER_SHAPE_VALUES } from "./media_timeline_calculations";

const MARKER_EDITOR_OFFSET = 8;
const MARKER_EDITOR_COLLISION_PADDING = 8;

type MediaTimelineMarkerEditorProps = {
  editing_marker_id: string | null;
  marker_editor_position: { x: number; y: number } | null;
  duration: number;
  marker_start_draft: number;
  marker_end_draft: number | null;
  marker_save_error: string | null;
  is_saving_marker: boolean;
  set_marker_start_draft: (value: number) => void;
  set_marker_end_draft: (value: number | null) => void;
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
  marker_save_error,
  is_saving_marker,
  set_marker_start_draft,
  set_marker_end_draft,
  cancel_marker_edit,
  save_marker,
  delete_marker,
}: MediaTimelineMarkerEditorProps) {
  return (
    <Popover
      open={editing_marker_id !== null}
      onOpenChange={(open) => {
        if (!open) cancel_marker_edit();
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
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(30rem,calc(100vw-1rem))] overflow-y-auto p-4"
        side="bottom"
        align="start"
        sideOffset={MARKER_EDITOR_OFFSET}
        collisionPadding={MARKER_EDITOR_COLLISION_PADDING}
      >
        <PopoverHeader>
          <PopoverTitle>编辑标记</PopoverTitle>
          <PopoverDescription>
            调整标记时间、点与范围形态，或删除标记。
          </PopoverDescription>
        </PopoverHeader>
        <form className="flex flex-col gap-4" onSubmit={save_marker}>
          <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="marker-start">开始时间（秒）</FieldLabel>
              <Input
                id="marker-start"
                autoFocus
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
                    ? Math.min(duration, marker_start_draft + 5)
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
                    删除后无法恢复，相关评分和范围信息也会一并移除。
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
