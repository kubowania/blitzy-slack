import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * Sonner toast host. Mounted once near the application root (the authenticated
 * app shell) so any module can fire a toast with `import { toast } from "sonner"`.
 *
 * This Vite application renders a single light theme (white content surface per
 * the design spec), so `theme` defaults to "light"; callers may override it.
 * The `style` block maps Sonner's internal CSS variables onto the project's
 * design tokens (`--color-popover`, `--color-popover-foreground`,
 * `--color-border`) so toasts inherit the shadcn palette rather than any
 * hardcoded color values.
 */
function Toaster({ theme = "light", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--color-popover)",
          "--normal-text": "var(--color-popover-foreground)",
          "--normal-border": "var(--color-border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
