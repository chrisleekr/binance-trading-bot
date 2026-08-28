import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/shared/lib/cn';

// The native <select> is deliberate: it hands the operator the platform picker — a wheel on iOS, a system dropdown elsewhere — which is reachable by keyboard, readable by a screen reader, and immune to the scroll traps a hand-built listbox introduces inside the app's scroll containers.
//
// Chrome mirrors Input, because a dropdown sits in the same forms and reading as a different species of field is how a row of controls stops looking like one row. `text-base` is 16px on the default tier for the iOS focus-zoom rule, which is why the base size is not smaller; the `sm` tier opts down to 14px, so this is a reason for the default rather than a guarantee the component makes everywhere.
//
// Width is deliberately absent. A select is `inline-block` by default and roughly half these call sites are chips inside a flex row ("Rows per page", "Group") where a `w-full` base would stretch them across the toolbar; the form fields that do want the full column ask for it.
const selectVariants = cva(
  'rounded-xs border border-border bg-surface-alt px-3 text-base text-fg focus-visible:border-focus focus-visible:ring-1 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        // ≥44px touch target: anything the operator commits, spends, or configures.
        default: 'h-11',
        // Dense secondary filters that only re-render data already on screen. Below the touch minimum on purpose, so choosing it is a decision a reviewer can see at the call site.
        sm: 'h-9 px-2 text-sm',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

/**
 * Props for {@link Select}: every native `<select>` attribute plus the height variant.
 *
 * The height rides `variant` rather than `size` because `<select>` already owns a native `size` attribute (the visible row count), and a cva variant of that name would collide with it in this type — silently retyping a DOM attribute as a string union.
 */
export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>, VariantProps<typeof selectVariants> {}

/**
 * The app's dropdown: a native `<select>` carrying the shared chrome and, by default, a 44px tap target.
 *
 * Height comes from here and never from a caller's `className`. Before this component existed most selects carried no height at all and rendered at the browser's ~26-34px default, which is under the touch minimum every Button already meets — and a per-call-site height class is exactly the thing the next author forgets. A dense filter opts out through `variant="sm"`; a caller that writes a height into `className` is caught by a test that parses the web source and reads the class strings written in that attribute, in the forms people actually write — a quoted class list, the strings handed to `cn(...)`, the fixed chunks of a template literal — though a height that arrives through a constant or any other computed value contributes no such string and is beyond it.
 *
 * @param className - Extra classes for layout only (width, margins), merged LAST so a caller's spacing wins a Tailwind conflict against the base chrome.
 * @param variant - Which height tier applies: `default` for anything that commits a value, `sm` for a dense secondary filter.
 * @param ref - Forwarded to the underlying `<select>`, so react-hook-form and focus management can reach the real element.
 * @returns The styled native select.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, variant, ...props }, ref) => (
    <select ref={ref} className={cn(selectVariants({ variant }), className)} {...props} />
  ),
);
Select.displayName = 'Select';
