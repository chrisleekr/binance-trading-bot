// lint-staged config (JS, not package.json) so the doc/config rule can drop symlinks
// before prettier. prettier 3 hard-errors on an explicitly-passed symbolic link, and the
// per-agent instruction files (CLAUDE.md, AGENT.md, GEMINI.md, .cursorrules) are symlinks
// to the one real charter, AGENTS.md. .prettierignore does NOT suppress this error for
// explicit paths, so the staged file list is filtered here instead.
import { lstatSync } from 'node:fs';

const notSymlink = (file) => {
  try {
    return !lstatSync(file).isSymbolicLink();
  } catch {
    return true;
  }
};

export default {
  '*.{ts,tsx,js,jsx,mjs,cjs}': ['oxlint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': (files) => {
    const real = files.filter(notSymlink);
    return real.length ? [`prettier --write ${real.map((f) => JSON.stringify(f)).join(' ')}`] : [];
  },
};
