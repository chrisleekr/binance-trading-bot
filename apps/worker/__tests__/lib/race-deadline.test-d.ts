// Compiler-enforced: the deadline helper takes a THUNK, never an already-created
// promise.
//
// A promise argument is evaluated by the CALLER, so a dependency that throws
// synchronously throws before the helper is even entered, and unwinds out of the
// caller instead of reaching `onError`. No runtime test can pin that shape closed,
// because the escape is in the call expression rather than in the helper body. Only
// the type system can make the dangerous call unwritable, so this file is the gate.

import { raceDeadline } from '../../src/lib/race-deadline.js';

const noop = (): void => {};

// A bare promise must not compile: whatever produced it already ran in the caller.
// Kept on ONE line because the compiler reports the failure at the ARGUMENT's
// position, and a directive only suppresses the line directly beneath it.
// @ts-expect-error a promise argument evaluates in the caller, escaping onError
void raceDeadline(Promise.resolve(), 10, noop, noop);

// Positive control. Un-suppressed, so this file fails if the thunk form is what
// breaks and the negative assertion above is passing for the wrong reason.
void raceDeadline(() => Promise.resolve(), 10, noop, noop);
