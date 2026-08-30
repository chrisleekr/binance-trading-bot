// Fixture stub: routes through the helper but hard-codes the repo root, so its stops can never be driven.
import { collectOrExit } from "./lib/walk.mjs";
export const files = collectOrExit({ root: "/repo" });
