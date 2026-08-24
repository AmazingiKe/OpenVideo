import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowDown, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function MessageScroller({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const viewport_ref = useRef<HTMLDivElement>(null);
  const [is_at_latest, set_is_at_latest] = useState(true);

  useEffect(() => {
    if (is_at_latest) {
      viewport_ref.current?.scrollTo({
        top: viewport_ref.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [children, is_at_latest]);

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={viewport_ref}
        className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4"
        onScroll={(event) => {
          const target = event.currentTarget;
          set_is_at_latest(
            target.scrollHeight - target.scrollTop - target.clientHeight < 24,
          );
        }}
        aria-live="polite"
      >
        {children}
      </div>
      {!is_at_latest ? (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="absolute right-4 bottom-4 rounded-full"
          aria-label="跳到最新消息"
          onClick={() => {
            viewport_ref.current?.scrollTo({
              top: viewport_ref.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <ArrowDown />
        </Button>
      ) : null}
    </div>
  );
}

export function Message({
  role,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { role: "user" | "assistant" }) {
  return (
    <div
      data-slot="message"
      data-role={role}
      className={cn(
        "flex w-full data-[role=assistant]:justify-start data-[role=user]:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function Bubble({
  role,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { role: "user" | "assistant" }) {
  return (
    <div
      data-slot="bubble"
      data-role={role}
      className={cn(
        "max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed break-words data-[role=assistant]:bg-muted data-[role=user]:bg-primary data-[role=user]:text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function MessageComposer({
  value,
  on_change,
  on_submit,
  disabled = false,
  pending = false,
}: {
  value: string;
  on_change: (value: string) => void;
  on_submit: () => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() && !disabled && !pending) on_submit();
  }

  return (
    <form className="flex items-end gap-2 border-t p-3" onSubmit={submit}>
      <Textarea
        value={value}
        onChange={(event) => on_change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (value.trim() && !disabled && !pending) on_submit();
          }
        }}
        placeholder="描述希望如何修改文档…"
        aria-label="Agent 指令"
        rows={2}
        disabled={disabled || pending}
        className="max-h-32 min-h-16 resize-none"
      />
      <Button
        type="submit"
        size="icon"
        disabled={disabled || pending || !value.trim()}
        aria-label="发送指令"
      >
        {pending ? <Spinner /> : <Send />}
      </Button>
    </form>
  );
}
