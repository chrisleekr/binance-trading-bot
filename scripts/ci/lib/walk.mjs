// The tree walk every scripts/ci scan gate decides its verdict with, plus the two stops that make that verdict evidence.
//
// A scan gate answers "does this invariant hold?" by walking a source tree and matching each file. The answer it prints is a count, and a count cannot distinguish a clean tree from a walk that stopped reaching the code. Twenty of these gates once carried only the first stop — refuse when the walk returns nothing — which catches a walk that collapses outright and nothing else. A walk narrowed by a widened skip-list, a renamed root, a re-layout, or a dropped extension clause still returns hundreds of files, so every one of those gates printed a confident count over a subset that no longer contained the module the rule exists to protect, and CI was green over an invariant nobody was checking any more.
//
// So both stops live here rather than in each gate, and a gate cannot take one without the other: every root MUST declare at least one anchor, or `collectOrExit` throws. That is the whole design. A grep-level meta-gate can only prove a gate calls this helper; requiring anchors at the call makes "calls the helper" mean "has both stops" by construction, which is what a syntactic check can never establish on its own.
//
// Anchors are checked PER ROOT, against that root's own files. A union walk with one shared floor and one shared anchor is fail-open in exactly the direction that matters: `apps` going dark still leaves hundreds of files from `packages`, satisfying both a whole-walk floor and a single anchor while apps/api, apps/worker and apps/web are never examined. Each root therefore has to contribute files AND contain every file that must always be in its own scope.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Collects one root's entries.
 *
 * @param dir - Absolute directory to read.
 * @param opts - `skip` (directory basenames never descended into), `test` (predicate over the absolute entry path), `entry` ("file" to collect files, "dir" to collect directories), `flat` (do not recurse).
 * @param out - Accumulator the matched absolute paths are pushed onto.
 * @returns The same accumulator, for chaining.
 */
const collect = (dir, opts, out) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // readdir does not resolve links, so a symlink reports neither isDirectory nor isFile and would fall through to the file branch as though it were one. Both ways of letting that pass fail in the direction this helper exists to close: read through the link and the gate scans, and prints matched lines from, a file outside its declared root; ignore a symlinked directory and everything under it leaves the walk silently, which is the narrowing that still satisfies both stops because the other roots keep the count healthy.
    //
    // Refused rather than skipped, but only where this walk would otherwise have taken it. A blanket refusal is not available: the repo root carries four editor-config symlinks, and the one gate that lists the root would then fail on them forever.
    if (e.isSymbolicLink()) {
      // throwIfNoEntry only suppresses ENOENT. A symlink cycle raises ELOOP and an unreadable target EACCES, and either would abort the walk with a raw errno instead of one of the two sentences this helper exists to print. A link that cannot be classified cannot be shown not to have narrowed the walk, so it is refused in the helper's own words.
      let target;
      try {
        target = fs.statSync(p, { throwIfNoEntry: false });
      } catch (err) {
        throw new Error(
          'walkRoots: unresolvable symlink under a scanned root: ' + p + ' (' + err.code + ')',
        );
      }
      if (target?.isDirectory()) {
        // Two ways a walk takes a directory, and both have to be refused. `entry: 'dir'` COLLECTS it, which is how the strategy-package listing enumerates plugins: drop one silently and the gate compares a shorter set against turbo while both stops still pass. A recursive walk DESCENDS it, and everything under it leaves the scan the same way.
        const wouldCollect = opts.entry === 'dir' && opts.test(p);
        const wouldDescend = !opts.flat && !opts.skip.has(e.name);
        if (wouldCollect || wouldDescend) {
          throw new Error('walkRoots: symlinked directory under a scanned root: ' + p);
        }
      } else if (opts.entry === 'file' && opts.test(p)) {
        throw new Error('walkRoots: symlinked file matches the scan: ' + p);
      }
      continue;
    }
    if (e.isDirectory()) {
      if (opts.entry === 'dir' && opts.test(p)) out.push(p);
      if (!opts.flat && !opts.skip.has(e.name)) collect(p, opts, out);
    } else if (e.isFile() && opts.entry === 'file' && opts.test(p)) {
      out.push(p);
    }
  }
  return out;
};

/**
 * Walks each declared root and reports what the walk found and what it failed to reach. Pure: it decides nothing and exits nothing, which is what lets the helper's own self-test drive every branch without spawning a gate.
 *
 * @param spec - `root` (absolute repo or fixture root), `roots` (one `{name, anchors}` per independently-floored subtree, `name` and `anchors` both root-relative), `skipDirs` (directory basenames never descended into), `test` (predicate over the absolute entry path), `entry` ("file" or "dir"), `flat` (depth-1 listing rather than a recursive descent).
 * @returns `files` (every matched absolute path, in root order), `empty` (names of roots that matched nothing), `missing` (declared anchors their own root did not reach).
 */
export const walkRoots = ({ root, roots, skipDirs = [], test, entry = 'file', flat = false }) => {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('walkRoots: no roots declared');
  const opts = { skip: new Set(skipDirs), test, entry, flat };

  const walked = roots.map((r) => {
    const anchors = r.anchors ?? [];
    // An anchor is what proves ITS root was reached, so one that does not live under that root is unsatisfiable-by-typo or, worse, satisfied by a sibling root's files and silently proves nothing. Refused at the call rather than reported as a walk failure, because it is a defect in the gate, not in the tree.
    //
    // This refusal is what makes the per-root anchor match below equivalent to a union match rather than merely stronger than one: once every anchor is known to live under its own root, no sibling root can satisfy it. Both are kept because they fail differently — remove the refusal and a misdeclared anchor goes quiet under a union match, so neither alone is the guard.
    if (anchors.length === 0) throw new Error('walkRoots: root ' + r.name + ' declares no anchor');
    for (const a of anchors) {
      if (a !== r.name && !a.startsWith(r.name + path.sep)) {
        throw new Error('walkRoots: anchor ' + a + ' is not under its root ' + r.name);
      }
    }
    return { name: r.name, anchors, files: collect(path.join(root, r.name), opts, []) };
  });

  const empty = walked.filter((r) => r.files.length === 0).map((r) => r.name);
  const missing = walked.flatMap((r) => {
    const reached = new Set(r.files.map((f) => path.relative(root, f)));
    return r.anchors.filter((a) => !reached.has(a));
  });

  return { files: walked.flatMap((r) => r.files), empty, missing };
};

/**
 * The gate-facing entry point: walks, refuses on either stop with the diagnostic that names which one fired, and otherwise hands back the files to scan.
 *
 * The two diagnostics are deliberately textually distinct. Both exit 1, so a self-test that only checked for a non-zero exit would read a walk failure as a successful catch; asserting the sentence is what tells the two apart.
 *
 * @param spec - Everything `walkRoots` takes, plus `label`: the human name for what is being collected (".ts/.tsx files", "markdown files"), which is the only part of the zero-file diagnostic that varies between gates.
 * @returns Every matched absolute path, in root order.
 */
export const collectOrExit = ({ label, ...spec }) => {
  const { files, empty, missing } = walkRoots(spec);

  // Zero files means the walk regressed, not that the invariant holds. Every empty root is named, so a half-dark walk and a wholly-dark one carry different text and a self-test can tell which one it drove.
  if (empty.length > 0) {
    console.error(
      'scan matched no ' + label + ' under ' + empty.join(', ') + ' — walk likely broken.',
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      'scan did not reach ' + missing.join(', ') + ' — walk narrowed, count is not evidence.',
    );
    process.exit(1);
  }

  return files;
};
