#!/usr/bin/env bash
# Self-test for scripts/ci/lib/walk.mjs, the shared walk every scan gate now decides its verdict with.
#
# Division of labour with the gate self-tests, so neither is a copy of the other. `collectOrExit`s two diagnostics and its exit code are proven end-to-end by no-error-cast.selftest.sh, which drives the real gate over four broken fixture trees and asserts each sentence by substring. What that cannot reach is the pure `walkRoots` underneath: the skip-list, the file-versus-directory and flat-versus-recursive modes, and the two contract refusals that make "routes through the helper" mean "has both stops". Those are asserted here, against the fixture trees under __fixtures__/walk-lib/.
#
# The contract refusals are the load-bearing half. A gate that declares no anchor would otherwise inherit only the zero-file floor and silently rejoin the blind majority, and an anchor pointed at the wrong root is worse than none: anchors were once matched against the UNION of every root, so `apps` anchored on a file that actually lives under `packages` is satisfied while apps/ is dark, which is precisely the fail-open the per-root design exists to close.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
root="$(cd -- "$dir/../.." && pwd)"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" FIXTURES="$dir/__fixtures__/walk-lib" bun -e '
const path = require("node:path");
const { walkRoots } = await import(process.env.CI_WALK_LIB);
const fixtures = process.env.FIXTURES;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(name + ": expected " + e + ", got " + a);
};
const checkThrows = (name, needle, fn) => {
  try {
    fn();
  } catch (err) {
    if (!String(err.message).includes(needle)) failures.push(name + ": threw, but not for " + needle + " (" + err.message + ")");
    return;
  }
  failures.push(name + ": expected a throw naming " + needle + ", got none");
};

const TS = (p) => p.endsWith(".ts") || p.endsWith(".tsx");
const APPS = { name: "apps", anchors: [path.join("apps", "web", "src", "main.tsx")] };
const PKGS = { name: "packages", anchors: [path.join("packages", "core", "src", "error", "error-message.ts")] };
const walk = (tree, over) =>
  walkRoots({ root: path.join(fixtures, tree), roots: over, skipDirs: ["node_modules", "dist"], test: TS });

// A whole tree: both roots contribute, both anchors are reached, and nothing is refused. The file count is asserted exactly rather than as "more than zero" — it is what pins the skip-list and the extension test at once, since the tree carries one .ts under a skipped dist/ and one .md that neither must collect.
const full = walk("tree", [APPS, PKGS]);
check("tree.files", full.files.map((f) => path.relative(path.join(fixtures, "tree"), f)).sort(), [
  path.join("apps", "api", "src", "index.ts"),
  path.join("apps", "web", "src", "main.tsx"),
  path.join("packages", "core", "src", "error", "error-message.ts"),
]);
check("tree.empty", full.empty, []);
check("tree.missing", full.missing, []);

// One root dark, the other healthy. The empty list names the dark root only, which is what lets a self-test tell a half-dark walk from a wholly dark one; a whole-walk floor cannot express the difference and reports neither.
const half = walk("empty-apps", [APPS, PKGS]);
check("empty-apps.empty", half.empty, ["apps"]);
check("empty-apps.missing", half.missing, [path.join("apps", "web", "src", "main.tsx")]);

// Both roots return real files and the walk still never reached the module the rule protects. This is the case a count cannot distinguish from a clean tree, and the only one the anchor answers.
const narrowed = walk("narrowed", [APPS, PKGS]);
check("narrowed.empty", narrowed.empty, []);
check("narrowed.missing", narrowed.missing, [path.join("packages", "core", "src", "error", "error-message.ts")]);

// A symlink is neither isDirectory nor isFile to readdir, so without an explicit case it falls through as a file and the gate reads THROUGH it, out of the declared root. Refused rather than collected.
checkThrows("symlink-file", "symlinked file matches the scan", () => walk("symlink-file", [APPS, PKGS]));

// The narrowing half, and the more dangerous one: a symlinked directory is not descended, so every file under it leaves the walk while the roots that remain keep the count healthy and both stops satisfied. That is the exact fail-open this helper exists to close, arriving by the one route neither stop classifies.
checkThrows("symlink-dir", "symlinked directory under a scanned root", () => walk("symlink-dir", [APPS, PKGS]));

// The refusal is scoped to what this walk would otherwise have taken. A symlink the predicate does not match is ignored, not refused, because the repo root carries four editor-config symlinks and the one gate that lists the root would otherwise fail on them forever.
// A symlinked directory whose basename is in skipDirs. The refusal is scoped to `!opts.skip.has(e.name)` precisely so this stays quiet: a symlinked node_modules is an ordinary workspace layout, and refusing it would hard-throw out of every gate that walks apps/. Drop that clause and this accepting case turns red.
const skipped = walk("symlink-dir-skipped", [APPS, PKGS]);
check("symlink-dir-skipped.files", skipped.files.map((f) => path.relative(path.join(fixtures, "symlink-dir-skipped"), f)).sort(), [
  path.join("apps", "web", "src", "main.tsx"),
  path.join("packages", "core", "src", "error", "error-message.ts"),
]);
check("symlink-dir-skipped.empty", skipped.empty, []);
check("symlink-dir-skipped.missing", skipped.missing, []);

const ignored = walk("symlink-ignored", [APPS, PKGS]);
check("symlink-ignored.files", ignored.files.map((f) => path.relative(path.join(fixtures, "symlink-ignored"), f)).sort(), [
  path.join("apps", "web", "src", "main.tsx"),
  path.join("packages", "core", "src", "error", "error-message.ts"),
]);
check("symlink-ignored.empty", ignored.empty, []);
check("symlink-ignored.missing", ignored.missing, []);

// Directory entries, depth 1. `flat` must not descend: the trailing-trade fixture holds a src/index.ts, so a recursive walk would collect src/ as a third directory.
const dirs = walkRoots({
  root: path.join(fixtures, "dirs"),
  roots: [{ name: path.join("packages", "strategy"), anchors: [path.join("packages", "strategy", "trailing-trade")] }],
  test: () => true,
  entry: "dir",
  flat: true,
});
check("dirs.files", dirs.files.map((f) => path.relative(path.join(fixtures, "dirs"), f)).sort(), [
  path.join("packages", "strategy", "momentum"),
  path.join("packages", "strategy", "trailing-trade"),
]);
check("dirs.missing", dirs.missing, []);

// The other way a walk takes a directory. `entry: "dir"` COLLECTS rather than descends, so the descent refusal above does not cover it and a linked plugin package would simply be absent from the set — with both stops satisfied, because the packages that remain keep the root non-empty and the anchor is one of them. That is the shape the strategy-package listing has, where a shorter set is compared against turbo and reported as agreement.
checkThrows("symlink-dir-flat", "symlinked directory under a scanned root", () =>
  walkRoots({
    root: path.join(fixtures, "symlink-dir-flat"),
    roots: [{ name: path.join("packages", "strategy"), anchors: [path.join("packages", "strategy", "trailing-trade")] }],
    test: () => true,
    entry: "dir",
    flat: true,
  }),
);

// Contract: a root with no anchor is refused at the call. Without this a gate could route through the helper, satisfy the grep-level meta-gate, and still carry only the floor it already had.
checkThrows("no-anchor", "declares no anchor", () =>
  walkRoots({ root: path.join(fixtures, "tree"), roots: [{ name: "apps" }], test: TS }),
);

// Contract: an anchor that does not live under its own root is refused. Under a union match this exact shape passes while apps/ is dark — the anchor is found among the packages/ files — so the refusal is what keeps the per-root floor from being decorative.
checkThrows("anchor-outside-root", "is not under its root", () =>
  walkRoots({
    root: path.join(fixtures, "empty-apps"),
    roots: [{ name: "apps", anchors: [path.join("packages", "core", "src", "error", "error-message.ts")] }, PKGS],
    test: TS,
  }),
);

// The refusals above are only evidence if the checker can see one fail. A deliberately wrong expectation proves the comparison is live, in the same spirit as the recogniser-liveness checks the scan gates carry.
const control = [];
{
  const before = failures.length;
  check("liveness-probe", [1], [2]);
  if (failures.length !== before + 1) control.push("check() did not report a mismatch");
  failures.length = before;
}
{
  // checkThrows carries the contract refusals, which this file calls its load-bearing half, and it is a different helper from check() with its own two failure paths. Both are probed: a call that does not throw at all, and one that throws for a reason the needle does not name. With neither, an inverted condition or a dropped push would leave every refusal above unfalsifiable while the file still printed OK.
  const before = failures.length;
  checkThrows("liveness-probe-no-throw", "anything", () => undefined);
  checkThrows("liveness-probe-wrong-needle", "declares no anchor", () => {
    throw new Error("an unrelated failure");
  });
  if (failures.length !== before + 2) control.push("checkThrows() did not report both failure modes");
  failures.length = before;
}
if (control.length > 0) {
  console.error("walk-lib self-test: the assertion helper is dead — " + control.join("; "));
  process.exit(1);
}

if (failures.length > 0) {
  console.error("walk-lib self-test: FAILED");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("walk-lib self-test: OK");
'
