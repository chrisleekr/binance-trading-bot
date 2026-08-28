#!/usr/bin/env bash
# Forbid stale plan/spec/issue/caller-list references in source comments.
# CLAUDE.md "Anti-patterns to refuse": comments must explain "why", not point
# at planning docs, issue numbers, or caller lists that rot when files move.
#
# Scans every .ts/.tsx/.js/.mjs file under apps/, packages/ and scripts/, and
# every .yml/.yaml file under those plus .github/, deploy/ and the repo root,
# minus the SKIP_DIR names below, for two forms. Both are anchored to a comment
# leader (line start, optional whitespace, then // or /* or * in source, or # in
# YAML):
#   keyword-form  Spec:  Issue #  Phase NN  Refs:|Ref:  Used by  Called from  @see
#   bare-form     an issue number anywhere in the comment body, e.g. (#436), (issue #407), epic #561, a leading "#496 combined ..."
#
# The bare form needs its own pattern because it carries no keyword, and it has
# to match the number wherever it sits: the first cut of this gate only matched
# a number in its own parentheses closing on the digit, which left 65 in-scope
# references passing while the gate reported OK.
#
# Three carve-outs, each pinned by a fixture:
#   * A CSS colour. `(?![0-9a-fA-F])` after the digits rejects #123456 and
#     #12345678 (every backtrack lands on a hex character) and #fff never starts
#     with a digit. A 3- or 4-digit ALL-NUMERIC hex (#123, #1234) is genuinely
#     indistinguishable from an issue number by any pattern; that is acceptable
#     here because arbitrary colour literals are already banned by
#     no-arbitrary-color-token.sh, so one cannot legitimately appear.
#   * `invariant #N` / `core invariant #N`, the charter's numbered-invariant
#     idiom. The check looks one line back as well, because a hard-wrapped JSDoc
#     splits it as `invariant` / ` * #1` and a line-local carve-out would fire on
#     the wrap.
#   * Five digits, not four. #99999 is far beyond anything this tracker will
#     reach, and no valid CSS hex is five digits long, so the bound buys headroom
#     without re-opening the colour false-positive that a six-digit bound would.
#
# CI and compose YAML are in scope because a pipeline definition is code the
# same way a module is, and its comments rot identically: the refs found there
# named a rate-limit ticket, an accepted trade-off and a dormant epic. The YAML
# leader is `#`, which is also the sigil the reference itself starts with, so
# the bare form needs a leader AND a separate `#NNN` later in the line.
#
# A reference SPLIT ACROSS LINES (`... (issue` / `// #407).`) is out of scope: a
# line-anchored pattern cannot see it and contorting the regex to try would cost
# more precision than it buys. Those are fixed by hand when found.
#
# Test fixtures under __tests__/ may keep references where load-bearing;
# vendored (MIT indicator) code keeps its upstream @see refs; __fixtures__/ holds
# this gate's own deliberately-failing trees and must never be scanned by the
# real run.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. The walk and both of
# its stops come from scripts/ci/lib/walk.mjs: a walk that returns nothing is a
# scan-path regression rather than a clean tree, and a walk that merely NARROWED
# still returns hundreds of files, so each root also names the file that must
# always be in its own scope.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-comment-refs

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-stale-comment-refs.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# Derived from $root, never from $GUARD_ROOT: a fixture tree must not be able to supply its own walk helper and define away the very stops this gate exists to require.
CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Line comments (//), block openers (/*, /**), and continuation lines inside a
// /** ... */ block (leading *), followed by a banned reference keyword.
const KEYWORD_BODY = String.raw`\s*(?:Spec:|Issue #|Phase [0-9]|Refs?:|Used by|Called from|@see)`;
const BARE_BODY = String.raw`.*(?<!invariant )#[0-9]{1,5}(?![0-9a-fA-F])`;
// Source files open a comment with //, /* or a continuation *; YAML opens with #.
const LEADER = { source: String.raw`(?:\/\/|\/\*+|\*)`, yaml: String.raw`#` };
const forms = (leader) => ({
  KEYWORD: new RegExp(String.raw`^\s*${leader}${KEYWORD_BODY}`),
  BARE: new RegExp(String.raw`^\s*${leader}${BARE_BODY}`),
});
const SYNTAX = { source: forms(LEADER.source), yaml: forms(LEADER.yaml) };
// The bare form puts the reference anywhere in the comment body. Anchoring on
// the leader is what keeps a #123 inside a string literal on a code line out of
// scope.
// A hard-wrapped comment breaks the invariant idiom over two lines, so the
// number the carve-out has to spare is the FIRST one on the following line.
const WRAPPED_INVARIANT = /(?:core\s+)?invariant\s*$/;

const SKIP_DIR = ["node_modules", "dist", "__tests__", "vendored", "__fixtures__"];
const EXTS = /\.(tsx?|m?js|ya?ml)$/;
const IS_YAML = /\.ya?ml$/;

// Walked and vacuity-checked PER ROOT by the shared helper. A union walk with one shared floor is fail-open in the direction that matters: apps/ going dark still leaves hundreds of files from packages/, so the floor holds while every comment in the three apps goes unread and the gate prints a confident count.
//
// The extension clause admits both file classes under every root, exactly as the scan requires. Neither class can go dark unseen: drop `ya?ml` and .github/ and deploy/ hold nothing but YAML, so both roots empty out; drop `tsx?|m?js` and apps/, packages/ and scripts/ empty out. Within the source class the narrower spellings need their own anchors, because a root that keeps ONE of them still reports a healthy count — hence a .tsx anchor under apps/ and an .mjs anchor under scripts/.
const dirFiles = collectOrExit({
  root,
  label: "source or YAML files",
  skipDirs: SKIP_DIR,
  test: (p) => EXTS.test(p),
  roots: [
    {
      name: "apps",
      anchors: [path.join("apps", "api", "src", "index.ts"), path.join("apps", "web", "src", "main.tsx")],
    },
    { name: "packages", anchors: [path.join("packages", "contracts", "src", "decimal.ts")] },
    {
      name: "scripts",
      anchors: [path.join("scripts", "setup.ts"), path.join("scripts", "ci", "lib", "walk.mjs")],
    },
    { name: ".github", anchors: [path.join(".github", "workflows", "ci.yml")] },
    { name: "deploy", anchors: [path.join("deploy", "compose", "docker-compose.yml")] },
  ],
});

// .gitlab-ci.yml, mkdocs.yml and .coderabbit.yaml sit at the repo root, under no scanned directory at all, and their comments rot the same way. walkRoots addresses a root by NAME beneath a parent, so the repo root is declared as its own basename one level up; `flat` keeps the listing at depth 1, so nothing outside the repo is ever read and the recursive roots above are not walked twice.
const rootYaml = collectOrExit({
  root: path.dirname(root),
  label: "repo-root YAML files",
  flat: true,
  test: (p) => IS_YAML.test(p),
  roots: [{ name: path.basename(root), anchors: [path.join(path.basename(root), ".gitlab-ci.yml")] }],
});

const files = [...dirFiles, ...rootYaml];

const keywordHits = [];
const bareHits = [];
for (const file of files) {
  const { KEYWORD, BARE } = IS_YAML.test(file) ? SYNTAX.yaml : SYNTAX.source;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const where = path.relative(root, file) + ":" + (i + 1) + ": " + lines[i].trim();
    const probe = WRAPPED_INVARIANT.test(lines[i - 1] ?? "") ? lines[i].replace(/#[0-9]{1,5}/, "") : lines[i];
    if (KEYWORD.test(lines[i])) keywordHits.push(where);
    else if (BARE.test(probe)) bareHits.push(where);
  }
}

if (keywordHits.length > 0 || bareHits.length > 0) {
  console.error("Banned stale reference comment(s) found:");
  if (keywordHits.length > 0) {
    console.error("  keyword-form (Spec:/Issue #/Phase N/Refs:/Used by/Called from/@see):");
    console.error(keywordHits.map((h) => "    " + h).join("\n"));
  }
  if (bareHits.length > 0) {
    console.error("  bare-form (a parenthesised issue number such as (#436)):");
    console.error(bareHits.map((h) => "    " + h).join("\n"));
  }
  console.error("");
  console.error("Comments must capture the \"why\", not point at .claude/plans/*, issue numbers,");
  console.error("phase labels, or caller lists. Delete the reference and one adjacent space; the");
  console.error("commit and the MR own that traceability. See CLAUDE.md \"Anti-patterns to refuse\".");
  process.exit(1);
}

console.log("no-stale-comment-refs gate: OK (" + files.length + " files scanned)");
'
