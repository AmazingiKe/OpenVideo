import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-control-background px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:bg-control-background-disabled disabled:opacity-50 aria-invalid:border-error-border aria-invalid:ring-3 aria-invalid:ring-error-ring md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
