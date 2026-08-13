// Binding a repo module's scope-first exports onto a per-request surface.
//
// The two tiers are deliberately separate rather than one generic over the
// scope type: the modules that mix tiers (`orders`, `overrideActions`,
// `profiles`) must be able to bind a DIFFERENT subset on each surface, and a
// single parameterised binder would make "profile-scoped" and "account-scoped"
// interchangeable at the call site, which is the distinction this file exists
// to keep.

import type { AccountScope, ProfileScope } from './_scoped.js';

/**
 * Strips the leading `scope: ProfileScope` from a scoped repo function so
 * a bound method reads `p.orders.insert(row)` instead of
 * `orders.insert(scope, row)`.
 */
type Bound<F> = F extends (scope: ProfileScope, ...rest: infer R) => infer Ret
  ? (...args: R) => Ret
  : never;

/**
 * Selects the profile-scoped functions of a module — those whose first
 * parameter is a {@link ProfileScope} — and binds each to a `scope`. A
 * module's account-scoped / global functions (first parameter `AccountScope`
 * or `Database`) are excluded from the public surface.
 */
export type ScopeBound<M> = {
  [
    K in keyof M as M[K] extends (scope: ProfileScope, ...rest: never[]) => unknown ? K : never
  ]: Bound<M[K]>;
};

/** {@link Bound} for the account tier: strips a leading `scope: AccountScope`. */
type AccountBound<F> = F extends (scope: AccountScope, ...rest: infer R) => infer Ret
  ? (...args: R) => Ret
  : never;

/**
 * Selects a module's account-scoped functions — those whose first parameter is
 * an {@link AccountScope} — and binds each to a `scope`. A module's
 * operator-scoped / global functions (first parameter `Database`, e.g.
 * `accounts.create` / `accounts.listForOwner`, `profiles.insert`) are excluded.
 */
export type AccountScopeBound<M> = {
  [
    K in keyof M as M[K] extends (scope: AccountScope, ...rest: never[]) => unknown ? K : never
  ]: AccountBound<M[K]>;
};

/** Bound names the surface's TYPE promises but an `only` list does not copy. */
type Missing<Surface, A extends readonly PropertyKey[]> = Exclude<
  keyof Surface & string,
  A[number]
>;

/**
 * The binder's result, or an uninhabited marker naming what `only` forgot.
 *
 * The whole point of the indirection: the surface type is derived from the
 * MODULE while the runtime object is built from the `only` array, and nothing
 * used to relate the two. An omitted name therefore typechecked at every call
 * site and was `undefined` when called. Resolving to a marker object makes the
 * assignment to `ScopeBound<M>` fail and puts the missing key in the error text.
 */
type BindResult<Surface, A extends readonly PropertyKey[]> = [Missing<Surface, A>] extends [never]
  ? Surface
  : { readonly __MISSING_FROM_only__: Missing<Surface, A> };

const bindTo = <M extends Record<string, unknown>>(
  scope: unknown,
  mod: M,
  only: readonly string[] | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const name of only ?? Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(scope, ...args);
  }
  return out;
};

/**
 * Binds a repo module's profile-scoped functions to `scope`.
 *
 * For a pure module — every function profile-scoped — call with two args. For a
 * mixed module (one that also exports user-scoped / global functions, e.g.
 * `profiles`, `auditLogs`, `actionLogs`), pass `only` with the profile-scoped
 * function names so the user-scoped / global ones stay off the runtime surface.
 *
 * `only` is checked BOTH ways, so the runtime object cannot drift from
 * `ScopeBound<M>`: a name that is not profile-scoped is rejected by the element
 * type, and a profile-scoped name the list forgets makes the return type
 * unassignable rather than silently `undefined` at call time.
 *
 * Pass `only` as an array literal written here. `const A` only narrows
 * expressions written at the call site, so a pre-annotated variable widens `A`
 * to the whole key union and the forgot-a-name half collapses; the derived
 * surface assertions in `scoped.test.ts` are the backstop for that.
 */
export const bindModule = <
  M extends Record<string, unknown>,
  const A extends readonly (keyof ScopeBound<M> & string)[] = readonly (keyof ScopeBound<M> &
    string)[],
>(
  scope: ProfileScope,
  mod: M,
  only?: A,
): BindResult<ScopeBound<M>, A> =>
  bindTo(scope, mod, only) as unknown as BindResult<ScopeBound<M>, A>;

/** {@link bindModule} for the account tier, with the same two-way `only` check. */
export const bindAccountModule = <
  M extends Record<string, unknown>,
  const A extends readonly (keyof AccountScopeBound<M> & string)[] =
    readonly (keyof AccountScopeBound<M> & string)[],
>(
  scope: AccountScope,
  mod: M,
  only?: A,
): BindResult<AccountScopeBound<M>, A> =>
  bindTo(scope, mod, only) as unknown as BindResult<AccountScopeBound<M>, A>;
