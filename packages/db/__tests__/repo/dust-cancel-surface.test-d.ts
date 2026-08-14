// Type-level contract for the dust-cancel pair on the bound profile surface.
// It lives here and not beside the behaviour suite because `__tests__/**/*.test.ts`
// is excluded from both tsconfigs — a signature assertion written there compiles
// nowhere and pins nothing, which is a guard that reads as present and is not.
//
// The shape that matters is the delete's return. It is the ids of rows that no
// longer exist, and the route copies them into the audit entry that is now their
// only trace. Narrowed back to a count, every call site still compiles and the
// audit entry silently loses the detail a disputed cancellation is settled with.

import type { ProfileRepo } from '../../src/repo/index.js';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import type { OverrideActionRow } from '../../src/schema/override-actions.js';

declare const p: ProfileRepo;
declare const scope: ProfileScope;

// Bound, not just exported: an allow-list omission leaves these `undefined` at
// call time while the module-level export still typechecks.
const active: Promise<OverrideActionRow | null> = p.overrideActions.findActiveDustTransfer();
void active;

const removed: Promise<readonly string[]> = p.overrideActions.deletePendingDustTransfer(new Date());
void removed;

// @ts-expect-error — the delete reports ids, never a count.
const asCount: Promise<number> = p.overrideActions.deletePendingDustTransfer(new Date());
void asCount;

// The scope is bound in, so the horizon is the first and only parameter and a
// caller cannot hand in a scope of its own. Written as the two-argument call
// rather than the zero-argument one: passing nothing is an ARITY error either
// way, so it would keep this directive consumed — and the guard green — even if
// the raw `(scope, staleBefore)` export leaked onto the bound surface.
// @ts-expect-error — the scope is bound in; a caller cannot pass its own.
void p.overrideActions.deletePendingDustTransfer(scope, new Date());
