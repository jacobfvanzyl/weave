import { type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Button = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    className={cn(
      'inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
