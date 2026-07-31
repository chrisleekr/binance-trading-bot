# UI interaction guidelines

Behavioural rules for `apps/web`. The **visual** system (tokens, colour, type) lives in `DESIGN.md`; this page covers **how controls behave** — variants, destructive actions, tables, touch targets, accessibility. These are the conventions that turn the component library into a system; a component without a usage rule drifts. Most are enforced in review, a few by lint.

## Buttons express intent through `variant`, never ad-hoc colour

`Button` (`apps/web/src/shared/components/ui/button.tsx`) is the single source of truth for control styling. Pick the variant that names the intent; do not hand-roll colour in `className`.

| Variant       | Use for                                              |
| ------------- | ---------------------------------------------------- |
| `default`     | Commit a configured value (Save, Update, selection). |
| `primary`     | Irreversible positive "go" (Run, Buy, Manual Order). |
| `outline`     | Secondary / neutral action.                          |
| `ghost`       | Low-emphasis action, icon buttons, menu triggers.    |
| `destructive` | Delete, Cancel order, Kill-switch, Sign out.         |

A destructive button is `variant="destructive"` — never `variant="ghost" className="text-[var(--danger)]"`. The variant carries the documented fill + foreground pair and the ≥44px size; a hand-rolled danger colour reads like a link, relies on colour alone, and drifts. This is a review-time convention (no automated lint gate). Danger colour on `<p>`/`<span>`/icons (error text, status) is fine — the convention is scoped to `<Button>`.

## Destructive actions: quiet trigger, loud confirmation

Visual prominence should track frequency × safety, **not** danger. A rare, irreversible action gets a _quiet_ trigger and a _loud_ confirm — not a permanently red control screaming on every row.

- Put the trigger in an overflow menu or a low-emphasis spot. Don't make it the loudest thing on screen.
- Gate it with a confirm dialog (`Dialog`, in `apps/web/src/shared/components/ui/dialog.tsx`) that is **specific**: name the thing and its consequence ("permanently removes run a1b2c3d4 and its result"), not "Are you sure?".
- Label both buttons with the outcome (verb + noun): "Delete run" / "Keep run" — not "OK" / "Cancel".
- Offer undo where feasible; if not, say "permanently" in the dialog body.

Source: [NN/g — Confirmation Dialogs Can Prevent User Errors (If Not Overused)](https://www.nngroup.com/articles/confirmation-dialog/).

## Tables: status is not an action

A status column shows read-only state. Actions go in their **own** trailing column, collapsed into one overflow (kebab) menu — never stacked under the status text. Use the shared `RowActions` component (`apps/web/src/shared/components/row-actions.tsx`):

```tsx
<RowActions
  label={`Actions for ${row.name}`} // accessible name for the trigger
  actions={[
    {
      key: 'retry',
      label: 'Retry',
      icon: <RotateCcw className="h-4 w-4" aria-hidden="true" />,
      onSelect: retry,
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
      destructive: true,
      onSelect: confirmDelete,
    },
  ]}
/>
```

When an action is unavailable, prefer **disabled with a reason** over hidden. A control that silently vanishes on some rows reads as broken; `RowActions` shows a disabled item with muted subtext ("Pinned as the live baseline") so "why can't I?" is never a mystery.

## Touch targets: 44px minimum

Per core invariant 3, every view must be fully usable on a 375×667 phone. Interactive controls are **≥44×44 px** — `Button` `size="default"` (h-11) or `size="icon"` (44×44). Do not use `size="sm"` (36px) for a primary or destructive action; it's below the touch floor (Apple HIG 44pt). `sm` is for dense, secondary controls only. Source: [WCAG 2.2 — Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Colour is never the only signal

Pair colour with a glyph, icon, or text label. Red-only / green-only state fails the roughly 8% of men with red-green colour-vision deficiency and is a WCAG violation. Status uses colour **plus** the status word; trade direction uses colour **plus** ▲/▼. Source: [WCAG 2.2 — Use of Colour](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

## Before adding an interactive element

1. Is there already a `variant` or shared component for this intent? Use it.
2. Is it destructive? Quiet trigger + confirm dialog + verb-noun labels.
3. Is it in a table row? Use `RowActions`, keep status and action separate.
4. Is it ≥44px and reachable on a 375px screen?
5. Does it convey state by more than colour alone?
