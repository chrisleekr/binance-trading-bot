// Slim re-export of the vendored util/ surface — only the helpers the
// vendored indicators in this tree actually import. The upstream
// trading-signals util/index.ts re-exported 13 helpers; we only need 2.
//
// Not vendored, not MIT-licensed code itself; written for this project.

export { getAverage } from './getAverage.js';
export { pushUpdate } from './pushUpdate.js';
