import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export function AgentMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 text-sm leading-relaxed",
        className,
      )}
      data-slot="agent-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safe_url}
        components={{
          h1: (props) => <h1 className="text-base font-semibold" {...props} />,
          h2: (props) => <h2 className="text-sm font-semibold" {...props} />,
          h3: (props) => <h3 className="text-sm font-medium" {...props} />,
          p: (props) => <p className="whitespace-pre-wrap" {...props} />,
          ul: (props) => (
            <ul className="flex list-disc flex-col gap-1 pl-5" {...props} />
          ),
          ol: (props) => (
            <ol className="flex list-decimal flex-col gap-1 pl-5" {...props} />
          ),
          li: (props) => <li className="pl-1" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-border pl-3 text-muted-foreground"
              {...props}
            />
          ),
          a: AgentMarkdownLink,
          table: (props) => (
            <div className="max-w-full overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border-b bg-muted px-3 py-2 font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b px-3 py-2" {...props} />,
          pre: (props) => (
            <pre
              className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs"
              {...props}
            />
          ),
          code: (props) => (
            <code
              className="rounded-sm bg-muted px-1 py-0.5 text-xs"
              {...props}
            />
          ),
          img: ({ alt }) => (
            <span className="text-muted-foreground">
              {alt ? `[图片：${alt}]` : "[图片]"}
            </span>
          ),
          hr: () => <Separator />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function AgentMarkdownLink({ href, ...props }: ComponentProps<"a">) {
  const external = href?.startsWith("http://") || href?.startsWith("https://");
  return (
    <a
      {...props}
      href={href}
      className="font-medium text-primary underline underline-offset-4"
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    />
  );
}

function safe_url(url: string): string {
  if (url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? url
      : "";
  } catch {
    return "";
  }
}
