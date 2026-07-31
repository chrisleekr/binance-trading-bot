import type * as React from 'react';
import type { FormField } from '@app/contracts';

/**
 * Uniform contract for every entry in {@link import('../widgetRegistry').widgetRegistry}.
 * Widgets receive only the RHF field name and the schema-derived metadata;
 * they pull value/onChange via `useController` from the surrounding
 * `FormProvider`, so the registry signature is the same whether the field
 * is a leaf, a sub-object, or an array.
 */
export interface WidgetProps {
  name: string;
  fieldDef: FormField;
  /**
   * Recurse into a nested schema field without importing `FieldRenderer`.
   * The renderer injects this at every widget call site (the same render-prop
   * `FieldGrid`/`FieldCells` already take), so a recursive widget renders
   * children through the callback instead of a static import that would close
   * the widgetRegistry -> widget -> field-renderer cycle. Present only when the
   * widget is rendered by `FieldRenderer` (always, in the app).
   */
  renderChild?: (field: FormField) => React.ReactNode;
}

/**
 * Stable render contract for the widget registry. Every entry is interchangeable
 * because all widgets accept the same {@link WidgetProps} shape, so the registry
 * can swap implementations across field kinds without touching consumers.
 */
export type Widget = React.ComponentType<WidgetProps>;
