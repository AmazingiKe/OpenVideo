import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function PlaybackProgressNotice({
  message,
}: {
  message: string | null;
}) {
  if (!message) return null;

  return (
    <Alert
      variant="destructive"
      className="max-h-24 shrink-0 overflow-y-auto rounded-none border-x-0 border-t-0"
      role="status"
      tabIndex={0}
    >
      <CircleAlert aria-hidden="true" />
      <AlertTitle>观看记录暂不可用</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
