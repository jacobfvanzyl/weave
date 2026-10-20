import { compactPath } from '@/lib/display-path';
import { cn } from '@/lib/utils';

// Keep the end visible even when two long directory names still overflow.
export function PathLabel({ path, className }: { path: string; className?: string }) {
  return <span dir='rtl' title={path} className={cn('block min-w-0 truncate text-left', className)}><bdi dir='ltr'>{compactPath(path)}</bdi></span>;
}
