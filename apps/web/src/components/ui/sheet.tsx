import * as React from "react";
import { XIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import {
  MotionOverlay,
  MotionSheetSurface,
  type SheetSide,
  use_overlay_open,
} from "@/components/ui/overlay-motion";
import { cn } from "@/lib/utils";

const SheetOpenContext = React.createContext<boolean | null>(null);

function Sheet({
  open: controlled_open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) {
  const { open, set_open } = use_overlay_open({
    open: controlled_open,
    default_open: defaultOpen,
    on_open_change: onOpenChange,
  });
  return (
    <SheetOpenContext.Provider value={open}>
      <SheetPrimitive.Root
        data-slot="sheet"
        open={open}
        onOpenChange={set_open}
        {...props}
      />
    </SheetOpenContext.Provider>
  );
}

function SheetTrigger(
  props: React.ComponentProps<typeof SheetPrimitive.Trigger>,
) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal(
  props: React.ComponentProps<typeof SheetPrimitive.Portal>,
) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay forceMount asChild {...props}>
      <MotionOverlay
        data-slot="sheet-overlay"
        className={cn(
          "fixed inset-0 z-50 bg-overlay supports-backdrop-filter:backdrop-blur-xs",
          className,
        )}
      />
    </SheetPrimitive.Overlay>
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: SheetSide;
  showCloseButton?: boolean;
}) {
  const open = React.useContext(SheetOpenContext);
  if (open === null) {
    throw new Error("SheetContent 必须在 Sheet 内使用");
  }
  return (
    <SheetPortal forceMount>
      <AnimatePresence>
        {open ? <SheetOverlay key="sheet-overlay" /> : null}
        {open ? (
          <SheetPrimitive.Content forceMount asChild {...props}>
            <MotionSheetSurface
              key="sheet-content"
              side={side}
              data-slot="sheet-content"
              data-side={side}
              className={cn(
                "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
                className,
              )}
            >
              {children}
              {showCloseButton ? (
                <SheetPrimitive.Close data-slot="sheet-close" asChild>
                  <Button
                    variant="ghost"
                    className="absolute top-3 right-3"
                    size="icon-sm"
                  >
                    <XIcon />
                    <span className="sr-only">关闭</span>
                  </Button>
                </SheetPrimitive.Close>
              ) : null}
            </MotionSheetSurface>
          </SheetPrimitive.Content>
        ) : null}
      </AnimatePresence>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
