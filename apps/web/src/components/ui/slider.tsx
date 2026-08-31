import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  variant?: "default" | "strength";
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  step = 1,
  variant = "default",
  "aria-label": aria_label,
  "aria-valuetext": aria_value_text,
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  );
  const strength_stop_count = Math.floor((max - min) / step) + 1;

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      step={step}
      data-variant={variant}
      aria-label={aria_label}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-full bg-muted data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
          variant === "strength"
            ? "data-horizontal:h-7"
            : "data-horizontal:h-1",
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute bg-primary select-none data-horizontal:h-full data-vertical:w-full"
        />
        {variant === "strength" ? (
          <span
            className="pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 items-center justify-between"
            aria-hidden="true"
          >
            {Array.from({ length: strength_stop_count }, (_, index) => (
              <span
                key={index}
                className="size-1 rounded-full bg-muted-foreground"
              />
            ))}
          </span>
        ) : null}
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={aria_label}
          aria-valuetext={aria_value_text}
          className={cn(
            "relative block shrink-0 rounded-full border border-focus bg-slider-thumb ring-focus-ring transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50",
            variant === "strength" ? "size-7 shadow-sm" : "size-3",
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
