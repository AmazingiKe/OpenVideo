import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type MediaTimelineTranscriptEditorProps = {
  editing_transcript_index: number | null;
  transcript_draft: string;
  is_saving_transcript: boolean;
  set_transcript_draft: (value: string) => void;
  save_transcript: (event: FormEvent<HTMLFormElement>) => void;
  cancel_transcript_edit: () => void;
};

export function MediaTimelineTranscriptEditor({
  editing_transcript_index,
  transcript_draft,
  is_saving_transcript,
  set_transcript_draft,
  save_transcript,
  cancel_transcript_edit,
}: MediaTimelineTranscriptEditorProps) {
  if (editing_transcript_index === null) return null;
  return (
    <form
      className="media_timeline_editor"
      onSubmit={(event) => void save_transcript(event)}
    >
      <Field className="media_timeline_editor_field">
        <FieldLabel htmlFor="timeline-transcript-editor" className="sr-only">
          编辑转写文字
        </FieldLabel>
        <Input
          id="timeline-transcript-editor"
          autoFocus
          value={transcript_draft}
          maxLength={10_000}
          onChange={(event) => set_transcript_draft(event.currentTarget.value)}
          disabled={is_saving_transcript}
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        disabled={is_saving_transcript || !transcript_draft.trim()}
      >
        {is_saving_transcript ? <Spinner data-icon="inline-start" /> : null}
        {is_saving_transcript ? "保存中…" : "保存"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={cancel_transcript_edit}
        disabled={is_saving_transcript}
      >
        取消
      </Button>
    </form>
  );
}
