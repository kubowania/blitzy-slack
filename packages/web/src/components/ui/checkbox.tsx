import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Checkbox primitive.
 *
 * shadcn/ui distributes its Checkbox on top of `@radix-ui/react-checkbox`,
 * which is not available in this offline workspace. This primitive preserves
 * the same shadcn look-and-feel and prop surface while being backed by a real
 * native `<input type="checkbox">`, so it stays fully accessible (native focus,
 * keyboard toggle, `htmlFor` label association) and drop-in compatible with
 * `react-hook-form` (`checked` / `onChange` / `onBlur` / `name` / `ref` all
 * forward straight to the input).
 *
 * The native control is styled with `appearance-none` and the check mark is an
 * overlaid lucide `Check` icon revealed via the `peer-checked` variant. Because
 * the input is the focusable element, form props forwarded through `...props`
 * (`checked` / `onChange` / `onBlur` / `name` / `ref` from react-hook-form)
 * land on the input itself, while `className` positions the control as a unit
 * (matching shadcn semantics where the class targets the visible box).
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<"input">): React.JSX.Element {
  return (
    <span
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center",
        className
      )}
    >
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          "peer size-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-input bg-transparent shadow-xs outline-none transition-[color,box-shadow]",
          "checked:border-primary checked:bg-primary",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20"
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100"
      />
    </span>
  )
}

export { Checkbox }
