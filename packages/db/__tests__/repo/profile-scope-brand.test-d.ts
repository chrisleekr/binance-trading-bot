// Type-level contract: `ProfileScope` is nominal via a module-private
// `unique symbol` brand. A structural literal `{ db, userId, profileId }`
// must NOT assign to `ProfileScope`, and a `value as ProfileScope` cast
// must NOT compile (the brand key is unnameable outside `_scoped.ts`).
// Compile errors here surface as a tsc failure during `bun run typecheck`.
//
// The runtime side of this contract — ownership check rejecting a wrong
// owner with `ProfileNotOwnedError` — lives in
// `__tests__/isolation/cross-account.test.ts`.

import type { ProfileId, UserId } from '@app/contracts';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import type { Database } from '../../src/repo/_db.js';

// Sentinel values; only their types matter for these assertions.
declare const db: Database;
declare const userId: UserId;
declare const profileId: ProfileId;

// @ts-expect-error — structural literal lacks the private brand key.
const forgedFromLiteral: ProfileScope = { db, userId, profileId };
void forgedFromLiteral;

// @ts-expect-error — `as` cast on an object literal trips excess-property
// + missing brand; the cast must not silence the brand requirement.
// Note: `as unknown as ProfileScope` (double-cast through `unknown`) is
// the accepted escape hatch of TS branding. The project forbids `as any`;
// for `as unknown as`, the convention is a code-review gate, not a
// compile-time one.
const forgedFromCast: ProfileScope = { db, userId, profileId } as ProfileScope;
void forgedFromCast;

// A value obtained from `scopeProfile()` IS assignable. The runtime
// invariants of the constructor are covered in cross-account.test.ts; here
// we only assert the type-level path compiles.
declare const realScope: ProfileScope;
const accepted: ProfileScope = realScope;
void accepted;
