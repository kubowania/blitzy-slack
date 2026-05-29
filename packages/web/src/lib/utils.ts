import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Composes Tailwind class names with conditional logic and conflict
 * deduplication.
 *
 * - Accepts strings, arrays, objects (`{ class: condition }`), and
 *   any other shape supported by `clsx`'s `ClassValue` type.
 * - Routes the composed output through `tailwind-merge` so that
 *   later utilities win over earlier conflicting ones
 *   (e.g., `cn('px-4', 'px-6')` resolves to `'px-6'`).
 *
 * This is the canonical shadcn/ui `cn` helper; the `aliases.utils`
 * entry in `components.json` resolves to this file so every shadcn
 * primitive in `@/components/ui/*` imports it from here.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
