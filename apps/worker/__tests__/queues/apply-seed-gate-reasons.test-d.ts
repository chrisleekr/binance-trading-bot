// Compiler-enforced: a stand-down reason the gate can return but the seed loop never iterates cannot exist.
//
// The hazard is asymmetric. A reason returned by `resolveApplySeedGate` but missing from the seeded tuple produces a labelled child born at its own first increment, which `increase()` reads as no change — the counter is present, the series looks healthy, and the rule over it can never fire. No runtime test can see that: the failure is the absence of a series nobody asked for. Deriving the reason union FROM the tuple is what makes the bad state unwritable, and these assertions are what stop the union from being widened back to a hand-written literal set that merely happens to agree today.

import {
  APPLY_SEED_GATE_STAND_DOWN_REASONS,
  type ApplySeedGateStandDownReason,
} from '../../src/queues/pipeline-worker.js';

type Assert<T extends true> = T;
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

// The whole design rests on this one. Hand-writing the union beside the tuple type-checks and drifts silently; deriving it cannot.
type _ReasonIsExactlyTheTuple = Assert<
  Equals<ApplySeedGateStandDownReason, (typeof APPLY_SEED_GATE_STAND_DOWN_REASONS)[number]>
>;
// A widened `string` would keep every negative assertion below "passing" while asserting nothing.
type _NotWidenedToString = Assert<
  Equals<ApplySeedGateStandDownReason, string> extends true ? false : true
>;
type _StringNotAssignable = Assert<string extends ApplySeedGateStandDownReason ? false : true>;
type _KnownMember = Assert<'no-client' extends ApplySeedGateStandDownReason ? true : false>;

declare function standDown(reason: ApplySeedGateStandDownReason): void;

// Positive control, un-suppressed: if the four rows above ever passed for the wrong reason, this is what still breaks.
standDown('getaccount-failed');

// @ts-expect-error a reason absent from the seeded tuple is not a stand-down reason the gate may return
standDown('no-exchange-info');
