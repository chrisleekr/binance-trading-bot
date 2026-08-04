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

## Loading states have height

The shell owns the only scroll surface (`h-svh … overflow-hidden`) and the document never scrolls, so a loading branch with no height leaves **nothing under the thumb to drag**. Combined with `overscroll-behavior: none`, which suppresses even the rubber-band, a phone reads that as a frozen app rather than a loading one — the app was unscrollable for 9–16 s per route on a slow link.

A loading branch renders a placeholder from `@/shared/components/page-skeleton`, never a bare `<p>Loading…</p>`:

| Surface | Use |
| --- | --- |
| Inside a `Panel` that already draws its frame | `LoadingRows` |
| A page body that will render a stack of panels | `PanelStackSkeleton shape={[…]}` — one entry per real panel, its value that panel's field count |
| A list or table | `TableSkeleton` |
| The router's pending screen, where the route is not yet known | `PageSkeleton` |

Rules that make them safe to render a page-full of:

- **Exactly one `role="status"` per loading surface.** The bars are `aria-hidden`; a live region per bar (or per panel) makes a screen reader read "Loading" once for every box.
- **No pulse under `prefers-reduced-motion`.** A full page of synchronised pulsing is a vestibular trigger.
- **Mirror the loaded layout, don't draw a bare frame.** A frame with no internal structure reads as a broken page. Match the panel count and field counts of what will land ([NN/g on skeleton screens](https://www.nngroup.com/articles/skeleton-screens/)).
- **A route that owns its own scroller must own it while loading too.** The full-screen routes drop `<main>`'s scroll, so their loading branch carries the same `min-h-0 flex-1 overflow-y-auto p-4` box the loaded branch does.

A one-line "Loading…" is still fine **inside a box that already has height** and whose chrome is drawn — the order-book and recent-trades panels, the realised-P/L card. The rule targets surfaces that would otherwise contribute no height at all.

## A polling page must hold the reader still

Every screen refetches on a timer. If a poll re-render changes layout above the fold, the reader is shoved off their spot; if it _rebuilds_ a subtree rather than updating it, the damage is worse and silent. While the subtree is detached the scroller is briefly shorter, so the browser clamps `scrollTop` to the new maximum — and re-inserting the content restores the height but never the scroll position. A reader parked at the bottom is dragged upward on every tick.

That shipped once. `MarketTrendCard` declared its wrapper component **inside** its own render body, so the wrapper got a fresh identity on every render and React discarded the card and rebuilt it. A `setInterval` driving the "next update in ~Xs" countdown fired that once a second. Measured in Safari at 375×667, the card's `getBoundingClientRect().height` was 298 px, and the scroller jumped by exactly that amount 24 times over a 12 s watch — twice per tick, because the dev build runs under `StrictMode`, which re-renders each component an extra time.

Rules:

- **Never declare a component inside another component's body.** Its identity changes per render, which React reads as a different component type: full teardown, not an update. Enforced by `react/no-unstable-nested-components` in `.oxlintrc.json`. A render prop that is _called_ rather than mounted (`fallback(error, reset)`) is safe, but hoist it anyway rather than relaxing the rule.
- **Keep list `key`s stable across polls.** A key derived from an array index or a formatted timestamp remounts rows whenever the data shifts.
- **Prefer a reserved box to a panel that appears and disappears.** A block that renders `null` on empty data and content on the next poll changes the page height under the reader.

`useScrollAnchor` (`overflow-anchor` is in Technology Preview and the Safari 27 beta, but no stable Safari release ships it and no iOS Safari release supports it — [caniuse](https://caniuse.com/css-overflow-anchor), checked 2026-08; the shim can be deleted once it lands on iOS) absorbs _legitimate_ reflow — content genuinely growing. It is not a licence to reflow: it corrects a frame late, and it stands down while the reader's own scrolling is live, because a `scrollTop` write during a drag or its momentum cancels the fling on WebKit instead of nudging the reader. A page that needs the shim to look still on a phone is a page with a layout bug.

"The reader's own scrolling" is measured against gestures, not scroll events. A scroll event is not proof a human scrolled: when content shrinks, the browser clamps `scrollTop` and emits one too, and that event is dispatched _before_ the animation frame the correction runs in. Standing down for it would disable the shim for the exact reflow it exists to absorb, and re-anchor at the drifted position — turning a one-frame clamp into permanent drift.

`e2e/tests/scroll-stability.spec.ts` measures this: it parks each route's anchored scroller (the one marked `data-scroll-anchor`, so the probe cannot drift onto an inner panel that no poll touches) at the bottom, **blocks the shim's corrections**, and asserts zero drift, zero subtree teardowns and zero attempted corrections while the page polls. Blocking the shim is the point — with it live, the drift is repaired a frame later and the page looks stable on Blink and desktop WebKit, which is why the defect survived review. The spec needs a running stack (`E2E_USER_EMAIL` / `E2E_USER_PASSWORD` / `E2E_ACCOUNT_ID` / `E2E_PROFILE_ID`); CI runs only the no-stack smoke subset, so it does not gate merges today.

## Before adding an interactive element

1. Is there already a `variant` or shared component for this intent? Use it.
2. Is it destructive? Quiet trigger + confirm dialog + verb-noun labels.
3. Is it in a table row? Use `RowActions`, keep status and action separate.
4. Is it ≥44px and reachable on a 375px screen?
5. Does it convey state by more than colour alone?
6. If it has a loading state, does that state have height and exactly one live region?
