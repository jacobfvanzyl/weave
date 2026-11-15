import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"
import { TYPE_ROLES } from "./type-scale"

// The type scale's roles are sizes: without this, tailwind-merge reads `text-meta` as a colour and
// drops it beside `text-muted-foreground`.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TYPE_ROLES] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
