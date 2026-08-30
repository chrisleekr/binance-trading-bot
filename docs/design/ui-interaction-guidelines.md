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

## Wide tables become a compact list below `md`

A table wide enough to need sideways scrolling on a 375 px phone is not usable there — the operator drags left and right to read one row. Below `md` such a table renders instead as a compact list: one two-line row per record (identity plus the number that matters, then the reason and the timestamp), with the full figures one tap away in a sheet. `TradeArchivePanel` + `ArchiveCompactList` is the worked example.

- **Both variants mount; CSS swaps them.** The compact list sits in an `md:hidden` wrapper, the table in `hidden md:block`. Never `matchMedia` — a JS breakpoint re-renders the whole list on every resize and disagrees with the CSS breakpoint during hydration.
- **The testids MUST be disjoint.** Both variants are in the DOM at once, so a shared `data-testid` makes every singular `getByTestId` throw on multiple matches, including tests written before the compact variant existed. Namespace them (`archive-*` table, `archive-card-*` list, `archive-detail-*` sheet) and check that no prefix locator cross-matches — `archive-card-profit-` does not prefix-match `archive-profit-`, and that is load-bearing.
- **The loading branch splits too**, one placeholder per variant, each inside the same wrapper as the surface it stands in for. One skeleton cannot be the right shape at both widths.
- **Portalled children escape the wrapper.** A Radix `Sheet` or `Dialog` opened from the compact list renders into `<body>`, outside `md:hidden`, so the breakpoint does not hide it and it survives a resize past `md`. Close it before anything reads the desktop surface.
- **Prove the swap in Playwright, not in the unit lane.** happy-dom loads no stylesheet, so a unit test can only assert the visibility classes are present. Whether `display:none` actually removed a variant from the accessibility tree is a browser fact, so assert it at a real viewport — counting a role that both variants render under the same accessible name catches a dropped `hidden` immediately.

## Touch targets: 44px minimum

Per core invariant 3, every view must be fully usable on a 375×667 phone. Interactive controls are **≥44×44 px** — `Button` `size="default"` (h-11) or `size="icon"` (44×44), `Select` `variant="default"` (h-11). Do not use the dense tier (`Button` `size="sm"`, `Select` `variant="sm"` — both 36px) for a primary or destructive action; it's below the touch floor (Apple HIG 44pt). The dense tier is for secondary controls only. Source: [WCAG 2.2 — Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Selects get their height from `Select`, never from a `className`

A dropdown is `Select` from `@/shared/components/ui/select` — a native `<select>` carrying the shared chrome and, by default, the 44px tap target. It renders the real element on purpose: the platform picker is keyboard-reachable, screen-reader-readable, and immune to the scroll traps a hand-built listbox introduces inside the shell's scroll container, and every e2e drives it with `selectOption`.

The height rides `variant`, not `size`, because `<select>` already owns a native `size` attribute (visible row count) and a variant of that name would collide with it in the props type. `variant="default"` (h-11) is anything that commits a value, moves money, or edits config; `variant="sm"` (h-9) is a dense secondary filter that only re-renders data already on screen — a rows-per-page control, a log level, a chart range. Choosing the dense tier is a decision a reviewer can see at the call site, which is the point of making it explicit rather than a default.

`className` on a `Select` is for layout only — width and margins. A height class there is what the component exists to prevent: before it, most selects carried no height at all and rendered at the browser's ~26-34px default, under the floor every `Button` already met. A `vitest` guard parses `apps/web/src` and refuses both spellings of the mistake — a raw `<select>` outside the component, and a `<Select>` re-sizing itself through `className` in any of the forms this codebase writes (a quoted class list, `cn(...)`, a template literal) — because a scan that knew only the first would match nothing once the call sites converted and pass forever. Parsing is what lets prose about a `<select>` stay prose: comments and strings are absent from a syntax tree. It reads the class strings written in the attribute itself, so a height that arrives through a constant or any other computed value is beyond it; that is a review question, not a gated one.

## Colour is never the only signal

Pair colour with a glyph, icon, or text label. Red-only / green-only state fails the roughly 8% of men with red-green colour-vision deficiency and is a WCAG violation. Status uses colour **plus** the status word; trade direction uses colour **plus** ▲/▼. Source: [WCAG 2.2 — Use of Colour](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

## Loading states have height

The shell owns the only scroll surface (`h-svh … overflow-hidden`) and the document never scrolls, so a loading branch with no height leaves **nothing under the thumb to drag**. Combined with `overscroll-behavior: none`, which suppresses even the rubber-band, a phone reads that as a frozen app rather than a loading one — the app was unscrollable for 9–16 s per route on a slow link.

A loading branch renders a placeholder from `@/shared/components/page-skeleton`, never a bare `<p>Loading…</p>`. A surface whose loaded body is too layout-specific for the shapes below mirrors its own markup instead, wrapped in the exported `LoadingStatus` so it still carries exactly one announcement — `ArchiveCompactSkeleton` is the worked example:

| Surface | Use |
| --- | --- |
| Inside a `Panel` that already draws its frame | `LoadingRows` |
| A page body that will render a stack of panels | `PanelStackSkeleton shape={[…]}` — one entry per real panel, its value that panel's field count |
| A list or table | `TableSkeleton` |
| A single unbroken area — a chart canvas, a stats strip | `BlockSkeleton className="…"` — the height is required and must match the loaded body |
| The router's pending screen, where the route is not yet known | `PageSkeleton` |

Rules that make them safe to render a page-full of:

- **Exactly one `role="status"` per loading surface.** The bars are `aria-hidden`; a live region per bar (or per panel) makes a screen reader read "Loading" once for every box. **Inline chrome is the exception** — a pill or badge sitting inside a larger surface takes a bare `Skeleton` with a static `aria-label` and _no_ live region, because a second one announces the same fetch twice and re-announces it on every poll. `TechnicalsHealthPill` is the worked example.
- **No pulse under `prefers-reduced-motion`.** A full page of synchronised pulsing is a vestibular trigger.
- **Mirror the loaded layout, don't draw a bare frame.** A frame with no internal structure reads as a broken page. Match the panel count and field counts of what will land ([NN/g on skeleton screens](https://www.nngroup.com/articles/skeleton-screens/)).
- **A route that owns its own scroller must own it while loading too.** The full-screen routes drop `<main>`'s scroll, so their loading branch carries the same `min-h-0 flex-1 overflow-y-auto p-4` box the loaded branch does.
- **Size the placeholder off the body it replaces.** Read the loaded branch and count its real rows; mirror its `max-h-*` cap and its responsive breakpoints. A three-row skeleton standing in for a 600 px panel passes the gate while leaving the same hole under the thumb.
- **A Tailwind height must be a source-text literal.** The JIT scans source, so ``className={`h-[${CHART_HEIGHT}px]`}`` compiles to nothing and the placeholder silently renders 0 px. Write `h-[320px]` and pin the constant with an assertion if the two must agree.
- **Only the loading arm gets a skeleton.** An error or a terminal empty state is not "still arriving" — a pulsing block there is a claim that never resolves. Split the branch and give each its own notice.

There is no longer an exemption for a one-line "Loading…" inside a box that already has height: `apps/web/__tests__/loading-placeholder-gate.test.ts` rejects it outright. The exemptions are structural, not per-file — a control label (`button`/`Button`/`option`/`summary`/`label`/`a`) as the **nearest** enclosing element, an `sr-only` element, and a value that cannot render (an inert attribute or object property; a render prop holding JSX is **not** exempt). If the gate flags a line, the fix is a sized placeholder, not an allow-list entry.

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

## A pane that scrolls must say so

Overlay scrollbars hide the track until the user is already scrolling, which is the one moment the affordance is redundant. That is unconditional on iOS, and it is what macOS does under its default "Automatically based on mouse or trackpad" setting whenever no mouse is attached — a trackpad-only Mac, which is most laptops. Plug a mouse in and the scrollbars turn persistent, so the gap is intermittent rather than universal, which is worse: it is invisible on the reviewer's desk setup and present on the operator's. A list clipped by its container therefore reads as a list that simply ends, and nothing on screen contradicts that reading. This is what stranded the desktop sidebar's ACCOUNT and SYSTEM sections behind an expanded profile — the rail was one scroll container with no visible scrollbar, so the rows below the fold were not merely out of view, they were unannounced.

The fix has two halves, and only the second is reusable. Structurally, a rail or panel with pinned chrome around a growing list is a flex column of three nested layers, and each layer wants a different thing:

- **The section that absorbs the leftover height** gets `flex-1` and a real floor — `min-h-[5.5rem]`, enough for one row plus the section's own chrome. Not `min-h-0` here: that lets the section shrink to zero on a short viewport, and a section that SHRANK leaves the outer container's fallback `overflow-y-auto` with nothing to reveal, so its content becomes unreachable rather than merely scrolled away. Every sibling section is `shrink-0`.
- **The wrapper inside it** is the usual `min-h-0 flex-1` clamp. `min-h-0` is correct and load-bearing at this layer, and at the shell layers above it (`apps/web/src/app/app-shell.tsx`) — the prohibition above is about the section that owns the floor, nothing else.
- **The scroller itself** is `h-full overflow-y-auto`. Without the clamp on its parent it grows to fit its content instead of scrolling, and nothing overflows at all.

For the affordance itself, `useOverflowEdges` (`apps/web/src/shared/lib/use-overflow-edges.ts`) reports `{ top, bottom }` — whether content is hidden past each edge — and callers render a gradient fade over the edges that are live. It takes TWO refs, the scroller and a stable wrapper around its contents, because content growth is invisible to the obvious single-ref version: expanding a row inside a flex-sized scroller fires no `scroll` event and does not change the scroller's own border box, so a `ResizeObserver` watching only the scroller never runs. Watching the inner wrapper is what catches it, and the wrapper must be rendered unconditionally or it stops being observed at the moment the list grows.

Two details are load-bearing. The predicates carry 1px of slack (`scrollTop > 1`, `scrollTop + clientHeight < scrollHeight - 1`) because fractional layout heights routinely leave a scroll a hair short of its own end, which would pin the bottom fade on permanently. And the fades are conditionally mounted rather than rendered at zero opacity, so a list that fits carries no decoration over its first and last rows at all — an always-present gradient dimming the top row of a short list is a worse artefact than the missing scrollbar it was meant to replace.

## Before adding an interactive element

1. Is there already a `variant` or shared component for this intent? Use it.
2. Is it destructive? Quiet trigger + confirm dialog + verb-noun labels.
3. Is it in a table row? Use `RowActions`, keep status and action separate.
4. Is it ≥44px and reachable on a 375px screen?
5. Does it convey state by more than colour alone?
6. If it has a loading state, does that state have height and exactly one live region?
