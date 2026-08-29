import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const textarea_variants = cva(
  "flex field-sizing-content min-h-16 w-full rounded-lg px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-error-border aria-invalid:ring-3 aria-invalid:ring-error-ring md:text-sm",
  {
    variants: {
      variant: {
        default:
          "border border-input bg-control-background focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus-ring disabled:bg-control-background-disabled",
        ghost:
          "border border-transparent bg-transparent focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Textarea({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textarea_variants>) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(textarea_variants({ variant, className }))}
      {...props}
    />
  );
}

export { Textarea };
