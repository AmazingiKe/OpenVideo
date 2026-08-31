import { cn } from "@/lib/utils";

type LoaderSize = "sm" | "md" | "lg";

export type LoaderProps = {
  variant: "typing" | "text-blink";
  size?: LoaderSize;
  text?: string;
  className?: string;
};

const TYPING_CONTAINER_SIZE: Record<LoaderSize, string> = {
  sm: "h-4",
  md: "h-5",
  lg: "h-6",
};

const TYPING_DOT_SIZE: Record<LoaderSize, string> = {
  sm: "size-1",
  md: "size-1.5",
  lg: "size-2",
};

const TEXT_SIZE: Record<LoaderSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

function TypingLoader({
  className,
  size,
}: {
  className?: string;
  size: LoaderSize;
}) {
  return (
    <span
      data-slot="loader"
      data-variant="typing"
      className={cn(
        "prompt-kit-loader-typing inline-flex items-center gap-1",
        TYPING_CONTAINER_SIZE[size],
        className,
      )}
    >
      {Array.from({ length: 3 }, (_, index) => (
        <span
          key={index}
          data-slot="loader-dot"
          className={cn("rounded-full bg-primary", TYPING_DOT_SIZE[size])}
        />
      ))}
      <span className="sr-only">正在加载</span>
    </span>
  );
}

function TextBlinkLoader({
  className,
  size,
  text,
}: {
  className?: string;
  size: LoaderSize;
  text?: string;
}) {
  return (
    <span
      data-slot="loader"
      data-variant="text-blink"
      className={cn(
        "prompt-kit-loader-text-blink font-medium",
        TEXT_SIZE[size],
        className,
      )}
    >
      {text ?? "正在思考"}
    </span>
  );
}

function Loader({ variant, size = "md", text, className }: LoaderProps) {
  if (variant === "typing") {
    return <TypingLoader size={size} className={className} />;
  }
  return <TextBlinkLoader text={text} size={size} className={className} />;
}

export { Loader };
