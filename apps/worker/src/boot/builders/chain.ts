// The single per-(profile, symbol) serialisation lock.
//
// This is the SOLE construction of a ChainByKey in the worker. The tick handler,
// the fill-adopter, the symbol-reconcile job, and the backstop cron all hold
// this one binding — a second instance would serialise against itself and let a
// cron interleave a state write with a live tick. The single-chain guard test
// pins this call site.

import { createChainByKey, type ChainByKey } from 'lib/chain-by-key.js';

export const buildChain = (): ChainByKey => createChainByKey();
