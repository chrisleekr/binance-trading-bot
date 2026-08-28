// Whether a navigation destination is offered in the public "Live demo".
//
// The field is REQUIRED on every nav registry entry, and that is the point: the demo operator is anonymous and a good third of the app's routes answer them with a 403, so "did anyone think about this destination" has to be a compile error rather than a review question. A default of `false` would let a new credential surface ship reachable.
//
// Lives in shared/lib rather than @app/core (this is apps/web chrome, not a domain concern) and not under features/profile (the app shell must not depend on a feature).

/** A navigation destination that has declared whether the live demo may offer it. */
export interface DemoVisible {
  /** True when the destination fronts an API route that 403s for the demo operator, so no nav surface may link to it while the demo is on. */
  readonly demoHidden: boolean;
}

/**
 * Whether a nav surface may render this destination right now.
 *
 * @param item - The registry entry, which carries its own demo declaration.
 * @param demoMode - Whether this deployment is the public live demo.
 * @returns True outside the demo, and inside it only for destinations that did not declare themselves hidden.
 */
export const visibleInDemo = (item: DemoVisible, demoMode: boolean): boolean =>
  !demoMode || !item.demoHidden;
