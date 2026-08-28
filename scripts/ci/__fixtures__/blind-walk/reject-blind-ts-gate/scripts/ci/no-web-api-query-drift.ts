// Fixture stub: a TypeScript gate that walks the tree itself, so it carries only the stops its author remembered.
import { readdirSync } from "node:fs";
const guardRoot = process.env["GUARD_ROOT"] ?? ".";
export const files = readdirSync(guardRoot);
