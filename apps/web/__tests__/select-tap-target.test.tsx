// Dropdowns are the last control class with no shared component, and it shows: of the native selects under `apps/web/src` most carried no height at all, rendering at the browser's ~26-34px default — well under the 44px minimum every Button already meets. A thumb aiming at a config field on a phone hits the row above it.
//
// The fix is a component, not a sweep of height classes: a class the next author forgets re-opens the gap silently, so the scan below refuses BOTH a native `<select>` outside the shared component and a `<Select>` re-sizing itself through `className`. The second half matters more than it looks — once every site is converted, a scan that only knows the lowercase tag matches nothing and passes forever.
//
// The scan parses each file rather than reading its bytes, because a byte scan cannot tell a rendered element from a sentence about one. It taxed three unrelated components into spelling the tag out in English to stay green, and a guard whose price is a wording contest gets paid in weaker prose until someone deletes it. Comment and string trivia is simply absent from a syntax tree, so those three components say what they mean again.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem, type FileSystem } from 'typescript/unstable/fs';
import { API, type Snapshot } from 'typescript/unstable/sync';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { Select } from '@/shared/components/ui/select';

// Filesystem-walking guard: parsing every source file with the compiler API competes with the rest of the parallel web suite for CPU, so the walk gets headroom above vitest's per-test default.
vi.setConfig({ testTimeout: 30_000 });

// Resolve the tree from this file, not `process.cwd()`: an ad-hoc `vitest run --root apps/web` from the repo root leaves cwd elsewhere and a cwd-based walk would silently pass on zero files.
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const SRC_ROOT = resolve(WEB_ROOT, 'src');
const SELECT_COMPONENT = 'src/shared/components/ui/select.tsx';
// Two files that must always be in scope. A file count catches a walk that broke outright, never one that merely narrowed: drop a feature directory and the count still looks plausible while the surfaces this guard was written for go unexamined. One anchor is the shared component, which is where the only legitimate native `<select>` lives, and the other is the entry point at the opposite end of the tree.
const ANCHORS: readonly string[] = ['src/main.tsx', SELECT_COMPONENT];

const VIRTUAL_TSCONFIG = '/select-gate/tsconfig.json';
const VIRTUAL_TSX = '/select-gate/input.tsx';
// A `.ts` file is parsed as TypeScript, not as TSX, because the two grammars disagree: `<T>(x)` is a type assertion in one and an unclosed element in the other. Feeding a `.ts` source to the TSX parser would turn an ordinary cast into "failed to parse" and take the whole guard down with it.
const VIRTUAL_TS = '/select-gate/input.ts';

const virtualFs: FileSystem = createVirtualFileSystem({
  [VIRTUAL_TSCONFIG]: JSON.stringify({
    compilerOptions: {
      jsx: 'preserve',
      noLib: true,
    },
    files: ['./input.tsx', './input.ts'],
  }),
  [VIRTUAL_TSX]: '',
  [VIRTUAL_TS]: '',
});

const writeVirtualFile = virtualFs.writeFile;
if (!writeVirtualFile) {
  throw new Error('TypeScript 7 virtual filesystem is not writable');
}

const tsApi = new API({ cwd: '/', fs: virtualFs });

let currentSnapshot: Snapshot | undefined;

/**
 * Parses one source through the compiler, in memory.
 *
 * Sources are pushed through a virtual filesystem rather than read from disk by the compiler, so a fault-injection fixture is a string in this file. A fixture written under `src` would be a permanent offender of the very scan it exists to exercise.
 *
 * @param fileLabel - Path used in offender output and, by its extension, to choose the TS or TSX grammar.
 * @param text - The source text to parse.
 * @returns The parsed source file, or a throw when it holds a syntax error.
 */
const parseSource = (fileLabel: string, text: string): ts.SourceFile => {
  const target = fileLabel.endsWith('.tsx') ? VIRTUAL_TSX : VIRTUAL_TS;
  writeVirtualFile(target, text);

  const nextSnapshot =
    currentSnapshot === undefined
      ? tsApi.updateSnapshot({ openProjects: [VIRTUAL_TSCONFIG] })
      : tsApi.updateSnapshot({ fileChanges: { changed: [target] } });

  currentSnapshot?.dispose();
  currentSnapshot = nextSnapshot;

  const project = nextSnapshot.getProject(VIRTUAL_TSCONFIG);
  if (!project) {
    throw new Error(`TypeScript 7 did not load ${VIRTUAL_TSCONFIG}`);
  }

  // Fail closed: a truncated tree holds no elements, so an unparsed file would otherwise be reported as offender-free.
  const diagnostics = project.program.getSyntacticDiagnostics(target);
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(
      `${fileLabel}: failed to parse (${diagnostics.length} error(s)): ${first?.text ?? 'unknown syntax error'}`,
    );
  }

  const source = project.program.getSourceFile(target);
  if (!source) {
    throw new Error(`TypeScript 7 did not return ${fileLabel}`);
  }

  return source;
};

afterAll(() => {
  tsApi.close();
});

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

interface ScanResult {
  readonly nativeSelects: readonly Offender[];
  readonly resizedSelects: readonly Offender[];
}

// Any height, `h-[44px]` included: the invariant is that height comes from the component, so an arbitrary value at a call site is the thing being caught, not an exception to it.
const HEIGHT_CLASS = /\b(?<!max-)(?:min-)?h-(?:\d|\[|full|auto|screen)/;

/**
 * Applies a visitor to a node and every descendant, pre-order.
 *
 * Written here rather than reached for from the compiler's own visitor helpers because this scan needs the whole subtree, not one level: a height class can sit arbitrarily deep inside a template or a conditional, and stopping at the first level is how the previous raw-bytes window missed them.
 *
 * @param node - Root of the subtree to descend, itself visited first.
 * @param visit - Called once per node, including the root.
 */
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

/**
 * The literal characters a node contributes to a class list, if any.
 *
 * The three template kinds are the fixed chunks around a substitution: `` `h-[44px] ${extra}` `` puts `h-[44px] ` in the head. A substitution's own value is not text this scan can read, which is the same blind spot as a constant.
 *
 * @param node - Any node reached while descending a `className` value.
 * @returns The node's literal text, or undefined when the node contributes no characters.
 */
const classLiteralText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return undefined;
};

/**
 * The `className` attribute of an opening element, or undefined when it carries none.
 *
 * Matched by attribute name rather than by position, and spread attributes are skipped rather than guessed at: a `{...props}` may carry a height this scan cannot see, which is a blind spot it shares with a constant.
 *
 * @param element - The opening or self-closing tag whose attributes are searched.
 * @returns The `className` attribute node, or undefined when the element sets none.
 */
const classNameAttribute = (
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): ts.JsxAttribute | undefined =>
  element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === 'className',
  );

/**
 * Whether a `className` value writes a height class in text this scan can read.
 *
 * "Can read" is the load-bearing qualifier: a substitution's value and an imported constant are both invisible here, so a false answer means no height was written IN THIS FILE, not that none reaches the element.
 *
 * @param attribute - The `className` attribute whose value is descended.
 * @returns Whether any literal chunk of the value carries a height class.
 */
const setsHeight = (attribute: ts.JsxAttribute): boolean => {
  const initializer = attribute.initializer;
  if (initializer === undefined) return false;
  let found = false;
  walk(initializer, (node) => {
    const text = classLiteralText(node);
    if (text !== undefined && HEIGHT_CLASS.test(text)) found = true;
  });
  return found;
};

/**
 * Finds both spellings of the tap-target mistake in one source.
 *
 * @param fileLabel - Path reported with each offender; also selects the grammar.
 * @param text - The source text to scan.
 * @returns Native `<select>` elements and `<Select>` elements setting their own height, each with its position.
 */
const scanSource = (fileLabel: string, text: string): ScanResult => {
  const source = parseSource(fileLabel, text);
  const nativeSelects: Offender[] = [];
  const resizedSelects: Offender[] = [];

  walk(source, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tag = node.tagName.getText();
    if (tag !== 'select' && tag !== 'Select') return;

    const { line, character } = source.getLineAndCharacterOfPosition(node.tagName.getStart(source));
    const offender: Offender = { file: fileLabel, line: line + 1, column: character + 1 };

    if (tag === 'select') {
      nativeSelects.push(offender);
      return;
    }
    const className = classNameAttribute(node);
    if (className && setsHeight(className)) resizedSelects.push(offender);
  });

  return { nativeSelects, resizedSelects };
};

/**
 * Collects the source files under a root, refusing a walk whose result cannot be evidence.
 *
 * `__tests__` directories are pruned: a test may render a bare `<select>` as a fixture, and this scan judges call sites, not fixtures.
 *
 * @param root - Directory to walk, normally the web source root.
 * @returns Every `.ts`/`.tsx` file under the root, relative to `apps/web`, or a throw when the walk found nothing or missed an anchor.
 */
const walkWebSource = (root: string): string[] => {
  const collect = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : collect(abs);
      return /\.tsx?$/.test(entry.name) ? [abs] : [];
    });

  const files = collect(root).map((abs) => relative(WEB_ROOT, abs).replaceAll('\\', '/'));
  const label = relative(WEB_ROOT, root) || root;

  // The two stops are worded apart on purpose: a walk that returns nothing and a walk that returns a plausible subset are different regressions, and a test that cannot tell which one fired cannot pin either.
  if (files.length === 0) {
    throw new Error(`scan matched no .ts/.tsx files under ${label} — walk likely broken.`);
  }
  const missing = ANCHORS.filter((anchor) => !files.includes(anchor));
  if (missing.length > 0) {
    throw new Error(
      `scan did not reach ${missing.join(', ')} — walk narrowed, so an empty offender list is not evidence.`,
    );
  }

  return files;
};

interface TreeScan extends ScanResult {
  readonly files: readonly string[];
}

let treeScan: TreeScan | undefined;

/** Parses the whole web source once; both arms below read the same pass. */
const scanWebSource = (): TreeScan => {
  if (treeScan) return treeScan;
  const files = walkWebSource(SRC_ROOT);
  const nativeSelects: Offender[] = [];
  const resizedSelects: Offender[] = [];
  for (const file of files) {
    const result = scanSource(file, readFileSync(join(WEB_ROOT, file), 'utf8'));
    nativeSelects.push(...result.nativeSelects);
    resizedSelects.push(...result.resizedSelects);
  }
  treeScan = { files, nativeSelects, resizedSelects };
  return treeScan;
};

/**
 * Renders offenders as `file:line:column` strings so a failing expectation names where to look rather than printing an object graph.
 *
 * @param offenders - Offenders from one scan, in source order.
 * @returns One position string per offender, in the same order.
 */
const locations = (offenders: readonly Offender[]): string[] =>
  offenders.map((o) => `${o.file}:${o.line}:${o.column}`);

const options = (
  <>
    <option value="a">A</option>
    <option value="b">B</option>
  </>
);

describe('<Select> tap target', () => {
  it('renders a native select at the 44px touch minimum by default', () => {
    render(
      <Select aria-label="Pick one" defaultValue="a" data-testid="s">
        {options}
      </Select>,
    );
    const el = screen.getByTestId('s');
    // Native, not a listbox widget: every e2e drives these with `selectOption`, and the platform picker is the accessible, zoom-free control on a phone.
    expect(el.tagName).toBe('SELECT');
    expect(el.className).toContain('h-11');
    expect(el.className).not.toContain('h-9');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('drops to the dense height only when a caller asks for it', () => {
    render(
      <Select variant="sm" aria-label="Dense" defaultValue="a" data-testid="s">
        {options}
      </Select>,
    );
    const el = screen.getByTestId('s');
    // The height rides a `variant`, not a `size`, because `<select>` already owns a native `size` attribute (visible rows) and a cva variant of that name would collide with it in the props type.
    // A sub-44px control has to be a deliberate, reviewable choice at the call site, never what a caller gets by saying nothing.
    expect(el.className).toContain('h-9');
    expect(el.className).not.toContain('h-11');
  });

  it('merges a caller className last, so layout survives without touching height', () => {
    render(
      <Select className="sm:w-72" aria-label="Wide" defaultValue="a" data-testid="s">
        {options}
      </Select>,
    );
    const el = screen.getByTestId('s');
    expect(el.className).toContain('sm:w-72');
    expect(el.className).toContain('h-11');
  });

  it('leaves no native select outside the shared component', () => {
    expect(existsSync(SRC_ROOT), `web source root missing at ${SRC_ROOT}`).toBe(true);
    const { nativeSelects } = scanWebSource();

    // The shared component's own `<select>` is the one legitimate native tag in the tree, so finding it is what makes the empty list below evidence: it proves the classifier is live against real files and not only against the virtual fixtures further down.
    expect(
      nativeSelects.map((o) => o.file),
      'the shared component itself no longer registers as a native select — the classifier, not the tree, is what changed',
    ).toContain(SELECT_COMPONENT);

    const outside = locations(nativeSelects.filter((o) => o.file !== SELECT_COMPONENT));
    expect(outside, `native <select> outside the shared component:\n${outside.join('\n')}`).toEqual(
      [],
    );
  }, 60_000);

  it('leaves no <Select> that re-sizes itself through className', () => {
    // Only the capitalised spelling is scanned here. A native tag carrying its own height is already refused above, by a rule that fires on the tag alone, so a second pattern for it could only ever match a subset of what has already failed.
    //
    // What counts as the class list is the `className` attribute's own value, read off the parsed element — nothing else in the opening tag, and nothing between tags. That is the whole difference from a text window running from `<Select` to some cut-off point: such a window reads a sibling attribute value or a JSX comment as though it were the class list, and a correct call site failing a guard is the pressure that turns the guard into a wording contest.
    //
    // Inside that attribute the scan reads the literal characters, in every form this codebase writes: a quoted list, the strings handed to `cn(...)`, the fixed chunks of a template literal, either arm of a conditional. A height that arrives through a constant, a variable, or any other computed value contributes no characters and is invisible — the known limit, and the reason `select.tsx` and the design doc say the guard catches the shapes people actually write rather than that the override is impossible.
    const offenders = locations(scanWebSource().resizedSelects);
    expect(
      offenders,
      `<Select> setting its own height through className:\n${offenders.join('\n')}`,
    ).toEqual([]);
  }, 60_000);
});

// Non-vacuity proofs for the two scans above. Every fixture is a virtual source, never a file on disk: a fixture written under `src` would become a permanent offender of the very scan it exists to exercise.
describe('select scan classifiers', () => {
  it('flags a native select in JSX position and clears the same spelling in prose', () => {
    // The tax the raw-bytes scan levied: three unrelated components had to spell the tag out in English because a byte scan cannot tell a rendered element from a sentence about one. Parsing removes the tax, so both halves are pinned here — neuter the classifier to make the tree green and this fails first, naming the classifier rather than the tree.
    const rendered = `
      export function Picker() {
        return <select aria-label="Pick"><option value="a">A</option></select>;
      }
    `;
    const selfClosing = `
      export function Picker({ inputRef }: { inputRef: Ref }) {
        return <select ref={inputRef} />;
      }
    `;
    const prose = `
      // \`block\` so a <select> (which defaults to display:inline-block) drops below its label.
      /** A sibling <label htmlFor> names an input or a <select> but NOT a <button>. */
      export function Note() {
        const help = 'write a <select> here and the scan should not care';
        return <Select aria-label={help}><option value="a">A</option></Select>;
      }
    `;

    expect(scanSource('rendered.tsx', rendered).nativeSelects.length).toBe(1);
    expect(scanSource('self-closing.tsx', selfClosing).nativeSelects.length).toBe(1);
    expect(scanSource('prose.tsx', prose).nativeSelects).toEqual([]);
  });

  it('flags a <Select> carrying a height in className, in every form written here', () => {
    const quoted = `export function A() { return <Select className="h-9 w-40" />; }`;
    const cnCall = `export function A({ wide }: { wide: boolean }) { return <Select className={cn('min-h-11', wide && 'w-full')} />; }`;
    const templated = `export function A({ extra }: { extra: string }) { return <Select className={\`h-[44px] \${extra}\`} />; }`;
    const conditional = `export function A({ dense }: { dense: boolean }) { return <Select className={dense ? 'h-9' : 'h-11'} />; }`;

    expect(scanSource('quoted.tsx', quoted).resizedSelects.length).toBe(1);
    expect(scanSource('cn-call.tsx', cnCall).resizedSelects.length).toBe(1);
    expect(scanSource('templated.tsx', templated).resizedSelects.length).toBe(1);
    expect(scanSource('conditional.tsx', conditional).resizedSelects.length).toBe(1);
  });

  it('clears a <Select> whose height text sits outside className', () => {
    // Both of these matched the raw-bytes window this scan replaces. That window ran from `<Select` to the next `<`, so a sibling attribute value or a JSX comment carrying a height class was read as though it were the class list — a correct call site failing the gate, which is the pressure that turns a guard into a wording contest.
    const otherAttribute = `export function A() { return <Select className="sm:w-72" data-testid="h-9-probe" />; }`;
    const jsxComment = `
      export function A() {
        return (
          <Select className="sm:w-72">
            {/* className="h-9" was rejected in review; the height belongs to the component */}
            <option value="a">A</option>
          </Select>
        );
      }
    `;
    const layoutOnly = `export function A() { return <Select className="sm:w-72" />; }`;
    // `min-h-` is a floor under the tap target and counts; `max-h-` is a scroll ceiling and does not. Without the lookbehind the word boundary lands between the `-` and the `h` of `max-h-64`, so a correct call site capping a long list would fail the guard.
    const maxHeight = `export function A() { return <Select className="max-h-64 sm:max-h-[50vh]" />; }`;

    expect(scanSource('other-attribute.tsx', otherAttribute).resizedSelects).toEqual([]);
    expect(scanSource('jsx-comment.tsx', jsxComment).resizedSelects).toEqual([]);
    expect(scanSource('layout-only.tsx', layoutOnly).resizedSelects).toEqual([]);
    expect(scanSource('max-height.tsx', maxHeight).resizedSelects).toEqual([]);
  });

  it('refuses a walk root it cannot have scanned, naming which stop fired', () => {
    // `public/` holds static assets only, so it is a real directory the walk legitimately finds nothing in.
    const emptyRoot = join(SRC_ROOT, '..', 'public');
    // Real components, but neither anchor is reachable from here: the narrowed walk a bare file count can never see, because the count still looks plausible.
    const narrowedRoot = join(SRC_ROOT, 'shared', 'components', 'ui');

    expect(() => walkWebSource(emptyRoot)).toThrow(/matched no \.ts\/\.tsx files/);
    // The two stops must not share wording, or a selftest cannot tell which one fired.
    expect(() => walkWebSource(emptyRoot)).not.toThrow(/walk narrowed/);
    expect(() => walkWebSource(narrowedRoot)).toThrow(/walk narrowed/);
    expect(() => walkWebSource(narrowedRoot)).toThrow(/main\.tsx/);
  });

  it('throws instead of reporting clean when a file cannot be parsed', () => {
    // A truncated syntax tree would otherwise be scanned as offender-free.
    expect(() => scanSource('broken.tsx', 'export function A() { return <div>;')).toThrow(
      /failed to parse/,
    );
  });
});
