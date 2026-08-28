import * as LabelPrimitive from '@radix-ui/react-label';
import * as React from 'react';

import { cn } from '@/shared/lib/cn';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    // `block` so a `<select>` (which defaults to display:inline-block) drops
    // below its label instead of sitting crammed inline beside it; matches how
    // block <Input> fields already stack. Flex-col label usages override this via
    // tailwind-merge, and native checkbox/radio <label>s do not use this component.
    className={cn('block text-sm leading-none font-medium', className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
