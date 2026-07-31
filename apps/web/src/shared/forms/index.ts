/** Top-level JSON-Schema-driven form component, the only widget consumers usually need. */
export { AutoForm, type AutoFormProps } from './auto-form';
/** Recursive renderer exposed so wizard steps can compose sub-trees outside an `AutoForm`. */
export { FieldRenderer } from './field-renderer';
/** Closed widget registry + lookup so renderers and tests share one canonical source. */
export { widgetRegistry, lookupWidget } from './widgetRegistry';
/** Widget contract types for downstream packages that ship custom registry entries. */
export type { Widget, WidgetProps } from './widgets/types';
/** Account-equity context so percent-of-account widgets can preview a quote figure. */
export { FormEquityProvider, useFormEquity, type FormEquity } from './form-equity';
