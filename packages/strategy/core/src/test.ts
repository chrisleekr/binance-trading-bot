// Test-only barrel for strategy authors. The shape mirrors what a unit
// test wants without having to dig into the determinism module path:
//   import { assertDeterministic } from '@app/strategy-core/test';
//
// Production code MUST NOT import from this module. There is no runtime
// difference between this and the main barrel today, but keeping the
// `/test` surface separate makes it cheap to add test-only helpers
// later (for example, a deterministic Clock factory or a fixture
// validator) without polluting the production exports.

export { assertDeterministic } from './determinism.js';
export type { DeterminismResult } from './determinism.js';
