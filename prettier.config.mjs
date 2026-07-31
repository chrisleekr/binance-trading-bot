/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
  plugins: ['prettier-plugin-tailwindcss'],
  // Tailwind v4 + this plugin: class sorting silently breaks without the
  // stylesheet pointer. See apps/web/src/styles/app.css and the
  // `prettier-plugin-tailwindcss` README.
  tailwindStylesheet: 'apps/web/src/styles/app.css',
  // Markdown prose: one paragraph, one line, repo-wide. Hard-wrapped prose turns every
  // later edit into a multi-line reflow, so the diff hides the sentence that actually
  // changed. `never` is not a ceiling, it actively joins wrapped lines back together,
  // which is what makes this enforceable rather than a convention that drifts.
  // Blocks whose meaning depends on a line break (a GFM `> [!WARNING]` marker, an
  // mkdocs grid) need a `<!-- prettier-ignore -->` fence.
  proseWrap: 'never',
};
