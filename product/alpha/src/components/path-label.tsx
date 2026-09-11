import { compactPath, compactTerminalTitle } from '@/lib/display-path';
import { cn } from '@/lib/utils';

// Keep the end visible even when two long directory names still overflow.
function EndLabel({ value, display, className }: { value: string; display: string; className?: string }) {
  return <span dir='rtl' title={value} className={cn('block min-w-0 truncate text-left', className)}><bdi dir='ltr'>{display}</bdi></span>;
}
export function PathLabel({ path, className }: { path: string; className?: string }) {
  return <EndLabel value={path} display={compactPath(path)} className={className} />;
}
export function TerminalTitle({ title, className }: { title: string; className?: string }) {
  const display = compactTerminalTitle(title);
  return <EndLabel value={display} display={display} className={className} />;
}
