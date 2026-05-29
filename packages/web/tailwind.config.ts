/**
 * Tailwind CSS configuration for the `@app/web` package.
 *
 * This file declares only the `content` globs that Tailwind scans to discover
 * the utility classes used across the source tree. Design tokens are declared
 * in `src/index.css` via the `@theme` directive.
 */
import type { Config } from 'tailwindcss';

const tailwindConfig = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config;

export default tailwindConfig;
