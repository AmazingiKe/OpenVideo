import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function FloatingError({ message }: { message: string }) {
  return (
    <Alert
      className="fixed right-4 bottom-4 max-w-sm shadow-lg"
      variant="destructive"
    >
      <CircleAlert aria-hidden="true" />
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
