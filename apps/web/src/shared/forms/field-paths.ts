import type { FormField } from '@app/contracts';

/**
 * Rewrite a path prefix across an element subtree. The form-builder bakes a
 * literal `$item` segment into every array-element descendant's `path`
 * (`buy.gridLevels.$item.triggerPercentage`); a rendered row must bind to the
 * concrete index (`buy.gridLevels.0.triggerPercentage`) or react-hook-form
 * writes the value to a phantom key and the array stays empty on submit.
 *
 * Relies on the form-builder invariant that an element's `path` is a literal
 * prefix of every descendant `path` (paths are built by positional segment
 * concatenation in `walkField`).
 *
 * Leaf module (no `field-renderer` import) so the recursive widget can reuse it
 * without closing the widgetRegistry -> widget -> field-renderer cycle.
 */
export function reindexPaths(node: FormField, fromPrefix: string, toPrefix: string): FormField {
  const path =
    node.path === fromPrefix
      ? toPrefix
      : node.path.startsWith(`${fromPrefix}.`)
        ? toPrefix + node.path.slice(fromPrefix.length)
        : node.path;
  if (node.kind === 'object') {
    return { ...node, path, fields: node.fields.map((f) => reindexPaths(f, fromPrefix, toPrefix)) };
  }
  if (node.kind === 'array') {
    return { ...node, path, element: reindexPaths(node.element, fromPrefix, toPrefix) };
  }
  return { ...node, path };
}
