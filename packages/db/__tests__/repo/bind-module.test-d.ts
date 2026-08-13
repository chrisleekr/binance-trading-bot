// Type-level contract: `bindModule`'s `only` list is checked in BOTH
// directions, so the runtime object it builds cannot drift from the
// `ScopeBound<M>` type the surface advertises.
//
// The failure this closes was silent by construction: the surface type came
// from the module and the runtime object from the array, with nothing relating
// them, so a forgotten name typechecked at every call site and was `undefined`
// only when someone finally called it. Compile errors here surface as a tsc
// failure during `bun run typecheck`.

import type { Database } from '../../src/repo/_db.js';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import { bindModule, type ScopeBound } from '../../src/repo/_bind.js';

declare const scope: ProfileScope;

// A stand-in for a MIXED repo module: two profile-scoped functions plus a
// db-first global, the shape that needs an `only` list at all. `db` is typed
// `Database` exactly as the real sweeps type it — parameter bivariance would
// admit a `db: unknown` first parameter into ScopeBound<M>, so a loosely typed
// stand-in would assert something the real modules never exercise.
declare const mixedModule: {
  readonly scoped: (scope: ProfileScope, id: string) => Promise<number>;
  readonly alsoScoped: (scope: ProfileScope) => Promise<void>;
  readonly globalSweep: (db: Database, olderThanMs: number) => Promise<void>;
};

// A PURE module: every export is profile-scoped, so the two-arg form applies.
declare const pureModule: {
  readonly get: (scope: ProfileScope, key: string) => Promise<string | null>;
  readonly set: (scope: ProfileScope, key: string, value: string) => Promise<void>;
};

// Complete list → the real bound surface, with the leading scope stripped.
const complete: ScopeBound<typeof mixedModule> = bindModule(scope, mixedModule, [
  'scoped',
  'alsoScoped',
]);
void complete.scoped('sym');
void complete.alsoScoped();

// @ts-expect-error — `only` omits `alsoScoped`, so the result resolves to the
// marker type naming it rather than to ScopeBound<M>.
const incomplete: ScopeBound<typeof mixedModule> = bindModule(scope, mixedModule, ['scoped']);
void incomplete;

// Pins the payload, not just the shape. The marker's whole value is naming the
// key `only` forgot, so `string` here would still pass if `Missing` were ever
// computed inverted and reported a name that IS present.
const naming: 'alsoScoped' = bindModule(scope, mixedModule, ['scoped']).__MISSING_FROM_only__;
void naming;

// @ts-expect-error — `globalSweep` is db-first, so it is not a member of
// ScopeBound<M> and cannot appear in `only`.
const bindsAGlobal = bindModule(scope, mixedModule, ['scoped', 'alsoScoped', 'globalSweep']);
void bindsAGlobal;

// Two-arg form still resolves to the full surface via the default type argument.
const pure: ScopeBound<typeof pureModule> = bindModule(scope, pureModule);
void pure.get('k');
void pure.set('k', 'v');
