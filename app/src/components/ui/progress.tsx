import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { cn } from "@/lib/utils"

function Progress({
  className,
  children,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-md bg-muted",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full bg-primary transition-all", className)}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-xs/relaxed font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-xs/relaxed text-muted-foreground tabular-nums",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  )
}

function CircularProgress({
  className,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  const percentage = typeof value === "number"
    ? Math.min(100, Math.max(0, value))
    : 0

  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="circular-progress"
      className={cn("relative size-5 shrink-0", className)}
      {...props}
    >
      <svg aria-hidden="true" className="size-full -rotate-90" viewBox="0 0 24 24">
        <circle
          className="fill-none stroke-muted"
          cx="12"
          cy="12"
          pathLength="100"
          r="9"
          strokeWidth="3"
        />
        <circle
          className="fill-none stroke-primary transition-[stroke-dashoffset]"
          cx="12"
          cy="12"
          pathLength="100"
          r="9"
          strokeDasharray="100"
          strokeDashoffset={100 - percentage}
          strokeLinecap="round"
          strokeWidth="3"
        />
      </svg>
    </ProgressPrimitive.Root>
  )
}

export {
  CircularProgress,
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
