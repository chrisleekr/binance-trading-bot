// Fixture stub: a TypeScript gate that routes its walk through the helper and parameterises its root.
import { collectOrExit } from "./lib/walk.mjs";
const guardRoot = process.env["GUARD_ROOT"] ?? ".";
export const files = collectOrExit({ root: guardRoot });
