import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A name typed where it shows, as a tab's or a Block's: Return or leaving the field keeps it, and
 * Escape leaves it as it was. When keeping it fails, the field stays with what went wrong, to try
 * again or give up.
 */
export function NameInput({ label, name, placeholder, maxLength = 80, className, onKeep, onDone }: {
  /** What the field is, as `Tab name`. */
  label: string;
  name: string;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  /** Keeps a name that isn't the one it had. */
  onKeep(name: string): void | Promise<void>;
  onDone(): void;
}) {
  const [value, setValue] = useState(name);
  const [failed, setFailed] = useState<{ value: string; message: string }>();
  const settled = useRef(false);
  const done = () => {
    if (settled.current) return;
    settled.current = true;
    onDone();
  };
  const keep = async () => {
    if (settled.current) return;
    if (value === name) return done();
    try {
      await onKeep(value);
      done();
    } catch (cause) {
      setFailed({ value, message: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  return (
    <>
      <input aria-label={label} aria-invalid={failed ? true : undefined} title={failed?.message} autoFocus maxLength={maxLength} value={value} placeholder={placeholder}
        className={cn(
          'h-6 w-36 min-w-0 rounded-sm border border-border bg-background px-1.5 text-xs text-foreground outline-none focus-visible:border-primary',
          failed && 'border-destructive focus-visible:border-destructive',
          className,
        )}
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') void keep();
          else if (event.key === 'Escape') done();
        }}
        // Leaving it with the name that just failed gives up on it.
        onBlur={() => { if (failed?.value === value) done(); else void keep(); }} />
      {failed && <span role='alert' className='sr-only'>{failed.message}</span>}
    </>
  );
}
