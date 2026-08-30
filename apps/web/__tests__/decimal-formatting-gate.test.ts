import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Contracts from '@app/contracts';
import { isDecimalStringSchema } from '@app/contracts';
// Deep path, not the package index: this needs the exports of the ONE module that owns the decimal contract, and the index folds them in with sixty other modules' exports. The registration check below is only fail-closed if it sees every export of that module, including ones added after this was written.
import * as DecimalModule from '@app/contracts/src/decimal.js';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem, type FileSystem } from 'typescript/unstable/fs';
import { API, type Snapshot } from 'typescript/unstable/sync';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Same budget as the sibling filesystem-walking guard: parsing every TSX file with the compiler API competes with the rest of the parallel web suite for CPU, so the walk needs headroom above vitest's per-test default.
vi.setConfig({ testTimeout: 30_000 });

// A money value crosses the wire as a plain decimal string carrying the full stored scale — `0.000307064092664099` is eighteen significant figures. Every display surface is expected to narrow that through a formatter; interpolate the raw field into JSX and the cell renders all eighteen, which on a 375px column wraps, shoves its neighbours out of alignment, and reads as a corrupted number rather than a small one.
//
// The exponential half of this defect was closed structurally (the wire encoder spells values with `Decimal#toFixed`), but nothing stops the precision half. This gate closes it statically.
//
// The field set is DERIVED from the contracts zod schemas, never listed here. A hand-maintained list of "known decimal fields" fails open on every field nobody remembered to add and reads as assurance while doing so; deriving it means a new decimal field is covered the moment its schema lands.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..', 'src');
// A file that must always be in scope, checked alongside the count floors below. It carries two decimal-typed columns and is one of the surfaces this gate was written to protect, so a walk that stops reaching it has narrowed past the point where its counts mean anything.
const ANCHOR = 'apps/web/src/features/account/routes/account.dust-transfer.tsx';
const VIRTUAL_TSCONFIG = '/decimal-gate/tsconfig.json';
const VIRTUAL_SOURCE = '/decimal-gate/input.tsx';

const virtualFs: FileSystem = createVirtualFileSystem({
  [VIRTUAL_TSCONFIG]: JSON.stringify({
    compilerOptions: {
      jsx: 'preserve',
      noLib: true,
    },
    files: ['./input.tsx'],
  }),
  [VIRTUAL_SOURCE]: '',
});

const writeVirtualFile = virtualFs.writeFile;
if (!writeVirtualFile) {
  throw new Error('TypeScript 7 virtual filesystem is not writable');
}

const tsApi = new API({ cwd: '/', fs: virtualFs });

let currentSnapshot: Snapshot | undefined;

const parseSource = (fileLabel: string, text: string): ts.SourceFile => {
  writeVirtualFile(VIRTUAL_SOURCE, text);

  const nextSnapshot =
    currentSnapshot === undefined
      ? tsApi.updateSnapshot({ openProjects: [VIRTUAL_TSCONFIG] })
      : tsApi.updateSnapshot({ fileChanges: { changed: [VIRTUAL_SOURCE] } });

  currentSnapshot?.dispose();
  currentSnapshot = nextSnapshot;

  const project = nextSnapshot.getProject(VIRTUAL_TSCONFIG);
  if (!project) {
    throw new Error(`TypeScript 7 did not load ${VIRTUAL_TSCONFIG}`);
  }

  const diagnostics = project.program.getSyntacticDiagnostics(VIRTUAL_SOURCE);
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(
      `${fileLabel}: failed to parse (${diagnostics.length} error(s)): ${first?.text ?? 'unknown syntax error'}`,
    );
  }

  const source = project.program.getSourceFile(VIRTUAL_SOURCE);
  if (!source) {
    throw new Error(`TypeScript 7 did not return ${fileLabel}`);
  }

  return source;
};

afterAll(() => {
  tsApi.close();
});

// ---------------------------------------------------------------------------
// Deriving the field set from the contracts schemas.
// ---------------------------------------------------------------------------

/**
 * zod v4 keeps a schema's definition on `_zod.def`. Read defensively because this walks values that are only *probably* schemas — every module export, and then everything reachable underneath one.
 *
 * @param schema - A candidate zod schema; anything at all, since the walk cannot know in advance.
 * @returns The schema's internal definition record, or undefined when the value is not a zod schema.
 */
const defOf = (schema: unknown): Record<string, unknown> | undefined => {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const internal = (schema as { _zod?: { def?: unknown } })._zod;
  const def = internal?.def;
  return typeof def === 'object' && def !== null ? (def as Record<string, unknown>) : undefined;
};

// Wrapper links that preserve the wrapped VALUE: `.nullable()`/`.optional()`/`.default()` keep `innerType`, effects and pipes split into `in`/`out`. A field spelled `DecimalString.nullable()` is still a decimal field, so the walk has to see through all of them.
const VALUE_LINKS = ['innerType', 'in', 'out'] as const;

// Container links, where the decimal is the ELEMENT rather than the field. Followed when enumerating nested object shapes (an array of row objects holds decimal fields), but deliberately NOT when deciding whether the field itself is a decimal: `fees: z.record(z.string(), DecimalString)` renders as an object, and a bare interpolation of it is a different defect with a different fix.
const CONTAINER_LINKS = ['element', 'valueType', 'keyType'] as const;

const childSchemas = (schema: unknown, links: readonly string[]): unknown[] => {
  const def = defOf(schema);
  if (!def) return [];
  const out: unknown[] = [];
  for (const link of links) {
    if (def[link] !== undefined) out.push(def[link]);
  }
  // Unions and intersections branch rather than wrap; a field that is a decimal down ANY arm still renders a decimal.
  if (Array.isArray(def['options'])) out.push(...def['options']);
  if (def['left'] !== undefined) out.push(def['left']);
  if (def['right'] !== undefined) out.push(def['right']);
  // `z.lazy` hides its target behind a thunk, which is how the recursive contracts spell themselves.
  const getter = def['getter'];
  if (typeof getter === 'function') {
    try {
      out.push((getter as () => unknown)());
    } catch {
      // A lazy thunk that cannot be forced in isolation contributes nothing; the schema it guards is reachable from its own export.
    }
  }
  return out;
};

/** Whether a field's schema resolves to a decimal string once its value-preserving wrappers are peeled off. */
const isDecimalField = (schema: unknown): boolean => {
  const stack: unknown[] = [schema];
  const visited = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === null || visited.has(node)) continue;
    visited.add(node);
    if (isDecimalStringSchema(node)) return true;
    stack.push(...childSchemas(node, VALUE_LINKS));
  }
  return false;
};

const shapeOf = (schema: unknown): Record<string, unknown> | undefined => {
  const def = defOf(schema);
  const shape = def?.['shape'];
  if (shape === undefined) return undefined;
  const resolved = typeof shape === 'function' ? (shape as () => unknown)() : shape;
  return typeof resolved === 'object' && resolved !== null
    ? (resolved as Record<string, unknown>)
    : undefined;
};

/** Every property name in the contracts whose value is a decimal string. */
const deriveDecimalFieldNames = (roots: Iterable<unknown>): Set<string> => {
  const names = new Set<string>();
  const visited = new Set<unknown>();
  const walk = (schema: unknown): void => {
    if (typeof schema !== 'object' || schema === null || visited.has(schema)) return;
    visited.add(schema);
    const shape = shapeOf(schema);
    if (shape) {
      for (const [name, field] of Object.entries(shape)) {
        if (isDecimalField(field)) names.add(name);
        walk(field);
      }
    }
    for (const child of childSchemas(schema, [...VALUE_LINKS, ...CONTAINER_LINKS])) walk(child);
  };
  for (const root of roots) walk(root);
  return names;
};

const contractRoots = Object.values(Contracts).filter(
  (value) => typeof value === 'object' && value !== null && '_zod' in value,
);

const DECIMAL_FIELD_NAMES = deriveDecimalFieldNames(contractRoots);

// ---------------------------------------------------------------------------
// The AST scan.
// ---------------------------------------------------------------------------

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly field: string;
}

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

/**
 * The decimal field name an expression reads, or undefined.
 *
 * Only two leaf shapes count, and both are the shape of a value going straight to the DOM: a bare identifier destructured off a payload, and a property read off one. `?.` and `!` are transparent. Anything else — most importantly a call — is where a formatter would live, so it terminates the search.
 *
 * @param expr - One painted expression from an interpolation slot, already unwrapped of the guarded spellings.
 * @param names - The decimal field names derived from the contracts schemas; membership is what makes a read an offender.
 * @returns The field name this expression reads raw, or undefined when it is not a bare decimal read.
 */
const decimalFieldRead = (expr: ts.Expression, names: ReadonlySet<string>): string | undefined => {
  if (ts.isParenthesizedExpression(expr)) return decimalFieldRead(expr.expression, names);
  if (ts.isNonNullExpression(expr)) return decimalFieldRead(expr.expression, names);
  if (ts.isIdentifier(expr)) return names.has(expr.text) ? expr.text : undefined;
  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.getText();
    return names.has(name) ? name : undefined;
  }
  return undefined;
};

/**
 * Every expression an interpolation slot can actually paint.
 *
 * A conditional paints one arm or the other, `??` and `||` paint either side, and `&&` paints only its right side (the left is the test). Recursing rather than reading the slot's expression directly matters because the offenders in this tree are written as guarded reads — `{row.bnbReceived ?? '—'}` renders the raw field exactly as `{row.bnbReceived}` does.
 *
 * Nested JSX is NOT followed: an element inside the slot owns its own child slots and is visited on its own turn, and a value handed to it as a prop is the callee's to format.
 *
 * @param expr - The slot's expression, or one of its branches on a recursive call.
 * @param out - Accumulator the leaf expressions are pushed onto; mutated in place rather than returned so the recursion stays allocation-free.
 * @returns Nothing; the painted leaves land in `out`.
 */
const paintedExpressions = (expr: ts.Expression, out: ts.Expression[]): void => {
  if (ts.isParenthesizedExpression(expr)) {
    paintedExpressions(expr.expression, out);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    paintedExpressions(expr.whenTrue, out);
    paintedExpressions(expr.whenFalse, out);
    return;
  }
  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      paintedExpressions(expr.right, out);
      return;
    }
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.PlusToken
    ) {
      paintedExpressions(expr.left, out);
      paintedExpressions(expr.right, out);
      return;
    }
    return;
  }
  // A template literal paints every substitution it holds, so `{`${row.price} BTC`}` leaks exactly as the bare read does.
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) paintedExpressions(span.expression, out);
    return;
  }
  out.push(expr);
};

/** A JSX expression sitting in a child slot, where its value becomes page text. */
const isChildSlot = (node: ts.JsxExpression): boolean => {
  const parent = node.parent;
  return parent !== undefined && (ts.isJsxElement(parent) || ts.isJsxFragment(parent));
};

interface ScanResult {
  readonly offenders: readonly Offender[];
  /** Every child-slot interpolation the walker judged — the denominator, so a walk that stops seeing JSX fails loudly rather than reporting clean. */
  readonly slots: number;
}

const scanSource = (
  fileLabel: string,
  text: string,
  names: ReadonlySet<string> = DECIMAL_FIELD_NAMES,
): ScanResult => {
  const src = parseSource(fileLabel, text);
  const offenders: Offender[] = [];
  let slots = 0;

  walk(src, (node) => {
    if (!ts.isJsxExpression(node) || !isChildSlot(node)) return;
    const expression = node.expression;
    if (expression === undefined) return;
    slots += 1;

    const painted: ts.Expression[] = [];
    paintedExpressions(expression, painted);

    for (const candidate of painted) {
      const field = decimalFieldRead(candidate, names);
      if (field === undefined) continue;
      const start = candidate.getStart(src);
      const { line, character } = src.getLineAndCharacterOfPosition(start);
      offenders.push({ file: fileLabel, line: line + 1, column: character + 1, field });
    }
  });

  return { offenders, slots };
};

const collectTsxFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsxFiles(abs));
    else if (entry.name.endsWith('.tsx')) out.push(abs);
  }
  return out;
};

describe('decimal fields reach the DOM through a formatter', () => {
  it('derives its field set from the contracts schemas', () => {
    // Non-vacuity for the derivation itself: an empty or collapsed set would make the whole gate report clean on any tree.
    expect(contractRoots.length).toBeGreaterThanOrEqual(200);
    expect(DECIMAL_FIELD_NAMES.size).toBeGreaterThanOrEqual(60);
    // Spot-checks across the three ways a decimal reaches a shape: bare, wrapped in `.nullable()`, and minted by the bounded factory. Each would silently drop out if the corresponding unwrap link were removed.
    expect(DECIMAL_FIELD_NAMES.has('estimatedBTC')).toBe(true);
    expect(DECIMAL_FIELD_NAMES.has('bnbReceived')).toBe(true);
    expect(DECIMAL_FIELD_NAMES.has('dailyLossLimitQuote')).toBe(true);
    // A non-decimal field on the very same object must NOT be in the set, or the walk is tagging everything it sees.
    expect(DECIMAL_FIELD_NAMES.has('asset')).toBe(false);
    expect(DECIMAL_FIELD_NAMES.has('canDustTransfer')).toBe(false);
  });

  it('recognises the bounded factory schemas, not only the shared constants', () => {
    // The factory mints a fresh object per call, so identity comparison against the exported constants cannot see it. Without the registry these fields are invisible and the derived set silently narrows.
    expect(isDecimalStringSchema(Contracts.DecimalString)).toBe(true);
    expect(isDecimalStringSchema(Contracts.PositiveDecimalString)).toBe(true);
    expect(isDecimalStringSchema(Contracts.decimalString('bounded'))).toBe(true);
    expect(isDecimalStringSchema(Contracts.decimalString('another', { gte: 0 }))).toBe(true);
    // And it must not answer true for everything: a schema that is not a decimal string, and a value that is not a schema at all.
    expect(isDecimalStringSchema(Contracts.DustAsset)).toBe(false);
    expect(isDecimalStringSchema('0.1')).toBe(false);
  });

  it('requires every decimal-producing schema in the decimal module to be registered', () => {
    // The registry closes the derivation hole, but registering is a step a human takes, so an unregistered new constant would narrow the derived field set while every other test here stayed green — the same fail-open, one level down, that deriving the field names exists to eliminate. This walks the module instead: whatever it exports has to answer for itself.
    //
    // "Decimal-producing" is decided behaviourally, not by name or by type: a schema that accepts a decimal string and refuses a non-decimal one is a decimal field wherever it came from. A schema that accepts both (a bare `z.string()`) or neither (a uuid, a timestamp) is not, and needs no registration.
    const acceptsDecimalsOnly = (value: unknown): boolean => {
      const schema = value as { safeParse?: (input: unknown) => { success: boolean } };
      if (typeof schema?.safeParse !== 'function') return false;
      try {
        return (
          schema.safeParse('1.5').success === true &&
          schema.safeParse('not-a-decimal').success === false
        );
      } catch {
        return false;
      }
    };

    // A factory hides its schema behind a call, which is how `decimalString` is spelled, so exported functions are probed too. The argument tuples cover this module's shape (a message, optional bounds); a function that throws or hands back anything else contributes nothing.
    const mintedSchemas = (fn: (...args: never[]) => unknown): unknown[] => {
      const out: unknown[] = [];
      for (const args of [[], ['probe'], ['probe', {}]]) {
        try {
          out.push((fn as (...a: unknown[]) => unknown)(...args));
        } catch {
          // A helper that cannot take these arguments is not a schema factory.
        }
      }
      return out;
    };

    const candidates: { readonly name: string; readonly schema: unknown }[] = [];
    for (const [name, value] of Object.entries(DecimalModule)) {
      if (typeof value === 'function') {
        for (const minted of mintedSchemas(value as (...args: never[]) => unknown)) {
          if (acceptsDecimalsOnly(minted)) candidates.push({ name: `${name}()`, schema: minted });
        }
        continue;
      }
      if (acceptsDecimalsOnly(value)) candidates.push({ name, schema: value });
    }

    // Non-vacuity: a module that failed to resolve, or a probe that classified nothing, would make the assertion below pass over an empty list.
    const found = candidates.map((c) => c.name).sort();
    expect(found).toContain('DecimalString');
    expect(found).toContain('PositiveDecimalString');
    expect(found).toContain('decimalString()');

    const unregistered = candidates
      .filter((c) => !isDecimalStringSchema(c.schema))
      .map((c) => c.name);
    expect(
      unregistered,
      `decimal-producing schemas exported from packages/contracts/src/decimal.ts that isDecimalStringSchema does not recognise:\n${unregistered.join('\n')}\nRegister each in decimalStringSchemas, or the derived field set silently narrows.`,
    ).toEqual([]);
  });

  it('flags a bare decimal interpolation and clears a formatted one', () => {
    // Permanent non-vacuity proof. If the classifier is neutered to make the suite green, this fails first and names the classifier rather than the tree.
    const bare = `
      export function Row({ asset }: { asset: DustAsset }) {
        return <td>{asset.estimatedBTC} BTC</td>;
      }
    `;
    const formatted = `
      export function Row({ asset }: { asset: DustAsset }) {
        return <td>{formatAmount(asset.estimatedBTC)} BTC</td>;
      }
    `;
    expect(scanSource('bare.tsx', bare).offenders.map((o) => o.field)).toEqual(['estimatedBTC']);
    expect(scanSource('formatted.tsx', formatted).offenders).toEqual([]);
    expect(scanSource('formatted.tsx', formatted).slots).toBe(1);
  });

  it('sees through the guarded reads a raw field is usually written as', () => {
    // `?? '—'` and `cond && field` render the raw value exactly as the bare read does, so treating the slot's top-level expression as opaque would hide the common spelling.
    const coalesced = `
      export function Row({ row }: { row: DustConversionRecord }) {
        return <td>{row.bnbReceived ?? '—'}</td>;
      }
    `;
    const guarded = `
      export function Row({ row }: { row: DustConversionRecord }) {
        return <td>{row.bnbReceived != null && row.bnbReceived}</td>;
      }
    `;
    const ternary = `
      export function Row({ row }: { row: DustConversionRecord }) {
        return <td>{row.bnbReceived ? row.bnbReceived : '—'}</td>;
      }
    `;
    const template = `
      export function Row({ row }: { row: Position }) {
        return <span>{\`\${row.entryPrice} USDT\`}</span>;
      }
    `;
    const destructured = `
      export function Row({ entryPrice }: Position) {
        return <span>{entryPrice}</span>;
      }
    `;
    expect(scanSource('coalesced.tsx', coalesced).offenders.length).toBe(1);
    expect(scanSource('guarded.tsx', guarded).offenders.length).toBe(1);
    expect(scanSource('ternary.tsx', ternary).offenders.length).toBe(1);
    expect(scanSource('template.tsx', template).offenders.length).toBe(1);
    expect(scanSource('destructured.tsx', destructured).offenders.length).toBe(1);
  });

  it('leaves a value passed as a prop to the callee that renders it', () => {
    // A prop is not a leaf: the component receiving it owns the formatting decision, and its own render body is scanned on its own turn. Flagging here would report every correct `<PnlValue value={row.profit} />` in the tree.
    const asProp = `
      export function Row({ row }: { row: Position }) {
        return <div><PnlValue value={row.pnlQuote} /><Cell price={row.entryPrice} /></div>;
      }
    `;
    // A condition is a test, not painted text.
    const asCondition = `
      export function Row({ row }: { row: Position }) {
        return <div>{row.entryPrice ? <Real /> : null}</div>;
      }
    `;
    expect(scanSource('prop.tsx', asProp).offenders).toEqual([]);
    expect(scanSource('condition.tsx', asCondition).offenders).toEqual([]);
  });

  it('throws instead of reporting clean when a file cannot be parsed', () => {
    // A truncated syntax tree would otherwise be scanned as offender-free.
    expect(() => scanSource('broken.tsx', 'export function A() { return <div>;')).toThrow(
      /failed to parse/,
    );
  });

  // Parses every TSX file under the web source root through the TypeScript compiler, so the default 5s deadline is a contention limit, not a correctness one. Bounded generously to catch a non-terminating walk and nothing else.
  it('every decimal field on a display surface passes through a formatter', () => {
    expect(existsSync(SRC_ROOT), `web source root missing at ${SRC_ROOT}`).toBe(true);

    const files = collectTsxFiles(SRC_ROOT);
    // A broken walk must fail loudly rather than report a clean tree.
    expect(files.length, 'TSX walk collected implausibly few files').toBeGreaterThanOrEqual(150);

    const offenders: string[] = [];
    const scanned: string[] = [];
    let slots = 0;

    for (const abs of files) {
      const rel = relative(resolve(HERE, '..', '..', '..'), abs)
        .split('\\')
        .join('/');
      scanned.push(rel);
      const result = scanSource(rel, readFileSync(abs, 'utf8'));
      slots += result.slots;
      for (const o of result.offenders) {
        offenders.push(`${o.file}:${o.line}:${o.column} (${o.field})`);
      }
    }

    // A count floor catches a walk that broke outright, never one that merely NARROWED: drop a whole feature directory and 150 files still come back from the rest of the tree while the surfaces this gate was written for go unexamined. Naming a file that must always be in scope is what turns the count into evidence.
    expect(
      scanned,
      'TSX walk no longer reaches its anchor file — the walk narrowed, so the counts above are not evidence',
    ).toContain(ANCHOR);

    expect(
      slots,
      'walker found implausibly few JSX interpolations — the detector is likely broken',
    ).toBeGreaterThanOrEqual(500);

    expect(
      offenders,
      `raw decimal-string fields interpolated into JSX without a formatter:\n${offenders.join('\n')}`,
    ).toEqual([]);
  }, 60_000);
});
