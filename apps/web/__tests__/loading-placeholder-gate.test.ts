import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: parsing ~190 TSX files with the compiler API
// competes with the rest of the parallel web suite for CPU, so the walk gets
// headroom above vitest's per-test default.
vi.setConfig({ testTimeout: 30_000 });

// The shell gives <main> `overscroll-behavior: none` and the document itself
// never scrolls, so the scroll range under a thumb comes entirely from the
// rendered subtree. A loading branch that paints one line of text occupies
// ~20px where the loaded surface occupies 200-600px, which on mobile Safari is
// indistinguishable from a frozen app for the length of the fetch. This gate
// finds those branches statically so they cannot come back.
//
// Two detectors run, and both are needed. A condition-shaped detector alone
// fails open the moment a site spells its pending check differently — the
// scoped-balances placeholder is guarded by `dashboard.data ? … : …`, which is
// a data test, not a loading test, and Detector A structurally cannot see it.
// A content-shaped detector alone cannot see a branch that renders a
// height-less non-"Loading" string. Union, then dedupe by file:line.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..', 'src');

// Interactive elements legitimately say "Loading…" inline while a fetch runs:
// a button label is not a page-height placeholder, and swapping it for a
// skeleton would destroy the control. Exemption is by enclosing structure, not
// by path — a hand-maintained path allow-list fails open forever once a file
// moves or a new offender lands next to an exempted one.
const CONTROL_TAGS = /^(button|Button|option|summary|label|a)$/;

// `LoadingRows` is a placeholder too, and the most-used one here; matching only
// on a `Skeleton` suffix would report a branch that reserves full height.
const SKELETON_TAG = /(Skeleton|LoadingRows)$/;

// `.isLoading` / `.isPending` / `.isFetching` / `.isPaused` off a query object.
// `isPaused` earns its place because `isLoading` is false while a first fetch
// is paused offline, so `isLoading || isPaused` is the correct guard — and
// without it here that whole `||` stops classifying and the branch goes unseen.
const QUERY_FLAG = /^(isLoading|isPending|isFetching|isPaused)$/;

// A bare `loading` / `isSymbolsLoading` style local, OR a destructured query
// flag. `isPending` and `isFetching` are idiomatic and do not end in "loading",
// so the suffix rule alone leaves `const { isPending } = useQuery()` invisible.
const isLoadingIdentifier = (name: string): boolean =>
  QUERY_FLAG.test(name) || /^(is)?\w*[Ll]oading$/.test(name);

interface Offender {
  readonly file: string;
  readonly line: number;
  /** Carried so two offenders on one line stay two entries, not one. */
  readonly column: number;
}

const tagNameOf = (node: ts.Node): string | undefined => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return undefined;
};

/**
 * A condition that unambiguously means "the data has not arrived yet".
 *
 * Negations, comparisons and `&&` chains are deliberately NOT loading tests:
 * `!isLoading && <Real/>` guards the loaded branch, and a compound condition
 * mixes in concerns this gate cannot reason about. Detector B is what keeps
 * those from being a hole.
 */
const isLoadingCondition = (expr: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(expr)) return isLoadingCondition(expr.expression);
  if (ts.isPropertyAccessExpression(expr)) return QUERY_FLAG.test(expr.name.text);
  if (ts.isIdentifier(expr)) return isLoadingIdentifier(expr.text);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return isLoadingCondition(expr.left) && isLoadingCondition(expr.right);
  }
  return false;
};

/** Loading-shaped copy: "Loading…", "Loading orders", "Fetching data…". */
const isLoadingText = (raw: string): boolean => {
  const s = raw.trim();
  if (s.length === 0) return false;
  if (/^loading\b/i.test(s)) return true;
  // A trailing ellipsis is the other half of the pattern: "Fetching trades…".
  return /[…]$/.test(s) && /\b(loading|fetching)\b/i.test(s);
};

/** An i18n lookup for a pending string: `t('symbol.orders.loading')`. */
const isLoadingTCall = (node: ts.Node): boolean => {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 't') return false;
  const [key] = node.arguments;
  return key !== undefined && ts.isStringLiteralLike(key) && /\.loading$/.test(key.text);
};

/** Any `t(...)` lookup, used by Detector A's "this branch renders text" test. */
const isTCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't';

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

/** Nearest enclosing JSX element, used to anchor a report and to spot controls. */
const enclosingJsxElement = (node: ts.Node): ts.Node | undefined => {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return n;
    n = n.parent;
  }
  return undefined;
};

/** `className="sr-only"` on the element itself: visually hidden, zero height. */
const isScreenReaderOnly = (node: ts.Node): boolean => {
  const attrs = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes
      : undefined;
  if (!attrs) return false;
  return attrs.properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      p.name.getText() === 'className' &&
      p.initializer !== undefined &&
      /\bsr-only\b/.test(p.initializer.getText()),
  );
};

/**
 * Whether a value contains JSX anywhere, and so can paint page height.
 * `aside={<StrategyPreviewPanel/>}` and `pendingComponent: () => <p>…</p>` are
 * render props — the host paints them as content, so exempting every attribute
 * and property wholesale would let a real offender through.
 *
 * Deliberately keyed on JSX, not on "is a function": `cell: (r) => r.isLoading
 * ? 'Loading…' : r.value` returns a string, paints no height, and reporting it
 * would fail CI on correct code. Both render-prop shapes carry JSX, so the JSX
 * test alone already covers them.
 */
const holdsJsx = (value: ts.Node | undefined): boolean => {
  if (value === undefined) return false;
  let found = false;
  walk(value, (n) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
  });
  return found;
};

/**
 * Structural exemptions. A node only matters when it can paint page height:
 * inside an inert attribute or object-literal property it renders nothing on
 * its own, directly inside a control it is a label rather than a placeholder,
 * and inside `sr-only` it is the announcement a skeleton stack pairs with —
 * hidden from layout, so it can neither carry height nor destroy it.
 */
const isStructurallyExempt = (node: ts.Node): boolean => {
  // The control exemption is bounded to the NEAREST enclosing element: an
  // unbounded ancestor walk exempts everything inside a `<label>` used as a
  // full-width card wrapper, however tall the placeholder inside it is.
  const nearest = enclosingJsxElement(node);
  if (nearest !== undefined) {
    const tag = tagNameOf(nearest);
    if (tag !== undefined && CONTROL_TAGS.test(tag)) return true;
  }

  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isJsxAttribute(n)) return !holdsJsx(n.initializer);
    if (ts.isPropertyAssignment(n)) return !holdsJsx(n.initializer);
    if (ts.isShorthandPropertyAssignment(n)) return true;
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isScreenReaderOnly(n)) return true;
    n = n.parent;
  }
  return false;
};

/**
 * The node sits where it will actually be painted as page content: a JSX child
 * slot, or the value a component returns.
 */
const isRenderedPosition = (node: ts.Node): boolean => {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isJsxAttribute(n)) return holdsJsx(n.initializer);
    if (ts.isPropertyAssignment(n)) return holdsJsx(n.initializer);
    if (
      ts.isJsxExpression(n) &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
    )
      return true;
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) return true;
    // A local binding or a bare statement is only rendered when it carries JSX
    // that some later `{body}` slot paints. Keyed on the whole VALUE, exactly
    // like the attribute and property clauses above: keying on the branch alone
    // would drop a mixed-arm local (`isLoading ? 'Still fetching' : <List/>`),
    // whose string arm is the 0px placeholder and which Detector B cannot see
    // either, since the slot's child is an identifier rather than copy.
    if (ts.isVariableDeclaration(n)) return holdsJsx(n.initializer);
    if (ts.isExpressionStatement(n)) return holdsJsx(n.expression);
    if (ts.isReturnStatement(n) || ts.isArrowFunction(n) || ts.isFunctionDeclaration(n))
      return true;
    n = n.parent;
  }
  return false;
};

/**
 * Tailwind tokens that reserve a real box on the smallest viewport.
 *
 * `max-h-` is absent because it caps a height rather than establishing one.
 *
 * The variant colon is absent from the allowed preceding characters, which
 * rejects EVERY variant-prefixed height, not only breakpoints. That bluntness
 * is deliberate: Tailwind breakpoints are min-width, so `sm:h-[320px]` alone
 * renders 0px at 375px — the exact defect this gate exists to catch — and
 * per-variant parsing would be more machinery than the one real case warrants.
 * A non-width variant that genuinely reserves height (`dark:h-40`,
 * `motion-safe:h-40`, `[&>*]:h-4`) is a known false positive; none exists in
 * the tree today, and the fix when one appears is to write an unprefixed base
 * height alongside it rather than to widen this rule. Failing closed is the
 * right direction here: CI goes red on correct code and names the line.
 *
 * The guard also rejects an `h-` that is only the tail of a longer word
 * (`search-`).
 */
const HEIGHT_TOKEN = /(?:^|[^a-zA-Z0-9:_-])(h-|min-h-|aspect-|size-)/;

/**
 * The classes a `cn(...)` call applies UNCONDITIONALLY, or undefined when an
 * argument is dynamic. `cn` is the house class-merging idiom, so leaving it
 * undecidable would let `className={cn('w-full')}` render 0px unchallenged;
 * but `cn('w-full', className)` genuinely cannot be judged here, because the
 * forwarded prop is where the height would come from.
 *
 * A conditional argument contributes nothing rather than folding its arm in:
 * `cn('w-full', expanded && 'h-40')` is 0px whenever `expanded` is false, so
 * counting that arm would call a sometimes-height a height. The cost is a false
 * positive on `cn(x ? 'h-40' : 'h-20')`, which is the right way to be wrong —
 * the author sees a red gate and writes an unconditional base height.
 */
const cnLiterals = (call: ts.CallExpression): string | undefined => {
  const parts: string[] = [];
  for (const arg of call.arguments) {
    if (ts.isStringLiteralLike(arg)) {
      parts.push(arg.text);
      continue;
    }
    if (
      ts.isConditionalExpression(arg) ||
      (ts.isBinaryExpression(arg) &&
        arg.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    )
      continue;
    return undefined;
  }
  return parts.join(' ');
};

/** The class list only when it is statically knowable at this call site. */
const staticClassName = (attr: ts.JsxAttribute): string | undefined => {
  const init = attr.initializer;
  if (init === undefined) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (!ts.isJsxExpression(init) || init.expression === undefined) return undefined;
  const e = init.expression;
  // A template keeps its static segments in `getText`, which is all this needs.
  if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return e.getText();
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'cn')
    return cnLiterals(e);
  // Anything else — a forwarded `className` prop — is decided at the call site,
  // which this gate checks there instead.
  return undefined;
};

/**
 * A skeleton element that reserves no height is the defect this gate exists to
 * catch, just spelled differently: `<BlockSkeleton className="w-full" />`
 * compiles, satisfies the tag-name check, and renders 0px.
 */
const isZeroHeightSkeleton = (node: ts.Node): boolean => {
  const tag = tagNameOf(node);
  if (tag === undefined || !SKELETON_TAG.test(tag)) return false;
  const props = ts.isJsxElement(node)
    ? node.openingElement.attributes.properties
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes.properties
      : undefined;
  if (props === undefined) return false;
  const className = props.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'className',
  );
  // No className at all is fine: the composite skeletons size their own bars.
  if (className === undefined) return false;
  const classes = staticClassName(className);
  if (classes === undefined) return false;
  return !HEIGHT_TOKEN.test(classes);
};

interface BranchVerdict {
  readonly rendersText: boolean;
  readonly hasSkeleton: boolean;
  /** Where to point the operator: the element carrying the text, if any. */
  readonly anchor: ts.Node;
}

const inspectBranch = (branch: ts.Node): BranchVerdict => {
  let rendersText = false;
  let hasSkeleton = false;
  let anchor: ts.Node | undefined;

  walk(branch, (n) => {
    const tag = tagNameOf(n);
    if (tag !== undefined && SKELETON_TAG.test(tag)) hasSkeleton = true;

    let isText = false;
    if (ts.isJsxText(n) && n.text.trim().length > 0) isText = true;
    else if (ts.isStringLiteralLike(n) && !isStructurallyExempt(n) && n.text.trim().length > 0)
      isText = true;
    else if (isTCall(n) && !isStructurallyExempt(n)) isText = true;

    if (isText) {
      rendersText = true;
      anchor ??= enclosingJsxElement(n) ?? n;
    }
  });

  return { rendersText, hasSkeleton, anchor: anchor ?? branch };
};

interface ScanResult {
  readonly offenders: readonly Offender[];
  /** Every loading branch the walker saw, offender or not — the denominator. */
  readonly loadingBranches: number;
}

const scanSource = (fileLabel: string, text: string): ScanResult => {
  const src = ts.createSourceFile(fileLabel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // `createSourceFile` error-recovers instead of throwing, so an unparseable
  // file would yield a truncated tree, contribute nothing, and be reported as
  // clean. `parseDiagnostics` is not on the public SourceFile type.
  const diagnostics = (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText, ' ');
    throw new Error(`${fileLabel}: failed to parse (${diagnostics.length} error(s)): ${first}`);
  }

  const offenders: Offender[] = [];
  // Keyed on start POSITION, not line: two distinct offenders can share a line,
  // and collapsing them costs an extra CI round trip to find the second.
  const seen = new Set<number>();
  let loadingBranches = 0;

  // The two detectors overlap by design on the common shape (a bare-text branch
  // guarded by a loading flag); both anchor to the same text-bearing element,
  // so deduping by position collapses them to one actionable site.
  const report = (n: ts.Node): void => {
    const start = n.getStart(src);
    if (seen.has(start)) return;
    seen.add(start);
    const { line, character } = src.getLineAndCharacterOfPosition(start);
    offenders.push({ file: fileLabel, line: line + 1, column: character + 1 });
  };

  // Detector A — condition-side.
  const considerBranch = (condition: ts.Expression, branch: ts.Node): void => {
    if (!isLoadingCondition(condition)) return;
    if (!isRenderedPosition(branch) || isStructurallyExempt(branch)) return;
    loadingBranches += 1;
    const verdict = inspectBranch(branch);
    if (verdict.rendersText && !verdict.hasSkeleton) report(verdict.anchor);
  };

  walk(src, (n) => {
    if (ts.isConditionalExpression(n)) considerBranch(n.condition, n.whenTrue);
    else if (ts.isIfStatement(n)) considerBranch(n.expression, n.thenStatement);
    else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
      considerBranch(n.left, n.right);
  });

  // Detector B — content-side. Any element carrying loading-shaped copy among
  // its children and no skeleton under it, whatever guards it. Deliberately not
  // restricted to a single child: `<div><Spinner /><p>Loading…</p></div>` is one
  // refactor away from the shape this detector exists to catch.
  walk(src, (n) => {
    if (!ts.isJsxElement(n)) return;
    // The ancestor walk starts above `n`, so the element's own tag / class have
    // to be checked here as well.
    if (isStructurallyExempt(n) || isScreenReaderOnly(n)) return;
    const tag = tagNameOf(n);
    if (tag !== undefined && CONTROL_TAGS.test(tag)) return;

    // Only the innermost element carrying the copy is reported; an outer
    // wrapper would otherwise be flagged for the same text.
    const carriesLoadingCopy = n.children.some((c) => {
      if (ts.isJsxText(c)) return isLoadingText(c.text);
      if (ts.isJsxExpression(c) && c.expression) {
        const e = c.expression;
        if (ts.isStringLiteralLike(e)) return isLoadingText(e.text);
        return isLoadingTCall(e);
      }
      return false;
    });
    if (!carriesLoadingCopy) return;

    let hasSkeleton = false;
    walk(n, (d) => {
      const t = tagNameOf(d);
      if (t !== undefined && SKELETON_TAG.test(t)) hasSkeleton = true;
    });
    if (!hasSkeleton) report(n);
  });

  // Zero-height skeletons: the same defect wearing the right tag name.
  walk(src, (n) => {
    if (isZeroHeightSkeleton(n)) report(n);
  });

  return { offenders, loadingBranches };
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

describe('loading placeholders carry page height', () => {
  it('the classifier flags a bare-text branch and clears a skeleton-bearing one', () => {
    // Permanent non-vacuity proof. If someone neuters a detector to make the
    // suite green, this fails first and names the classifier, not the tree.
    const bare = `
      export function Bare() {
        const q = useQuery();
        return <div>{q.isLoading ? <p>Loading…</p> : <Real />}</div>;
      }
    `;
    const skeletoned = `
      export function Good() {
        const q = useQuery();
        return <div>{q.isLoading ? <PanelSkeleton rows={3} /> : <Real />}</div>;
      }
    `;

    const bareResult = scanSource('bare.tsx', bare);
    const goodResult = scanSource('good.tsx', skeletoned);

    expect(bareResult.offenders.length).toBe(1);
    expect(goodResult.offenders).toEqual([]);
    // Both are loading branches — the good one is counted, just not flagged.
    expect(bareResult.loadingBranches).toBe(1);
    expect(goodResult.loadingBranches).toBe(1);
  });

  it('detector A alone catches a loading branch whose copy is not loading-shaped', () => {
    // Reachable ONLY by the condition-side detector: the copy does not match
    // any loading pattern and the element has two children, so neither of
    // Detector B's rules fires. Without this, neutering Detector A's report
    // would leave every other test in this file green.
    const onlyDetectorA = `
      export function Orders() {
        const q = useQuery();
        return <div>{q.isPending ? <p><Spinner /> Please wait for your orders</p> : <Real />}</div>;
      }
    `;
    const result = scanSource('only-a.tsx', onlyDetectorA);
    expect(result.offenders.length).toBe(1);
    expect(result.loadingBranches).toBe(1);
  });

  it('detector B alone catches a loading placeholder guarded by a data test', () => {
    // Reachable ONLY by the content-side detector: the condition is a data
    // test, which Detector A deliberately does not treat as a loading test.
    const onlyDetectorB = `
      export function Balances() {
        const dashboard = useQuery();
        return dashboard.data ? <List rows={dashboard.data} /> : <p>Loading…</p>;
      }
    `;
    const result = scanSource('only-b.tsx', onlyDetectorB);
    expect(result.offenders.length).toBe(1);
    // Nothing here is a loading CONDITION, so Detector A saw no branch at all.
    expect(result.loadingBranches).toBe(0);
  });

  it('detector A sees a destructured query flag, not just a *Loading name', () => {
    // `isPending` / `isFetching` are idiomatic and do not end in "loading", so a
    // suffix-only identifier rule leaves the destructured form invisible.
    const destructured = `
      export function Equity() {
        const { data, isPending, isError } = useEquitySnapshots();
        return <div>{isPending ? <p>Crunching your numbers</p> : <Chart data={data} />}</div>;
      }
    `;
    const result = scanSource('destructured.tsx', destructured);
    expect(result.offenders.length).toBe(1);
    expect(result.loadingBranches).toBe(1);
  });

  it('detector A still sees a branch guarded by `isLoading || isPaused`', () => {
    // `isLoading` is false while a first fetch is paused offline, so that pair
    // is the correct guard. `||` classifies only when BOTH sides are loading
    // tests, so dropping `isPaused` from the flag set would make every branch
    // written this way invisible — the strictest guard would be the least
    // checked one.
    const paused = `
      export function Card() {
        const q = useQuery(opts);
        return <div>{q.isLoading || q.isPaused ? <p>Loading baseline…</p> : <Real />}</div>;
      }
    `;
    const result = scanSource('paused.tsx', paused);
    expect(result.offenders.length).toBe(1);
    expect(result.loadingBranches).toBe(1);
  });

  it('detector B catches loading copy sharing an element with a sibling', () => {
    // The copy sits in the SAME element as the sibling node, so this really does
    // exercise the multi-child path rather than an inner single-child element.
    const withSibling = `
      export function Balances() {
        const dashboard = useQuery();
        return dashboard.data ? <List /> : <div><Spinner />Loading…</div>;
      }
    `;
    expect(scanSource('sibling.tsx', withSibling).offenders.length).toBe(1);
  });

  it('flags a skeleton that reserves no height, including a breakpoint-only one', () => {
    // The right tag name is not the invariant — the reserved box is.
    const flat = `
      export function Chart({ isLoading }: { isLoading: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className="w-full rounded-md" /> : <Real />}</div>;
      }
    `;
    // Tailwind breakpoints are min-width, so this is 0px on the 375px phone
    // this whole gate exists to protect.
    const breakpointOnly = `
      export function Chart({ isLoading }: { isLoading: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className="w-full sm:h-[320px]" /> : <Real />}</div>;
      }
    `;
    const sized = `
      export function Chart({ isLoading }: { isLoading: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className="h-[300px] w-full sm:h-[320px]" /> : <Real />}</div>;
      }
    `;
    expect(scanSource('flat.tsx', flat).offenders.length).toBe(1);
    expect(scanSource('breakpoint-only.tsx', breakpointOnly).offenders.length).toBe(1);
    expect(scanSource('sized.tsx', sized).offenders).toEqual([]);
  });

  it('reads a cn() class list rather than treating it as undecidable', () => {
    // `cn` is the house idiom, so leaving it unjudged would be a standing hole.
    const flatCn = `
      export function Chart({ isLoading }: { isLoading: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className={cn('w-full')} /> : <Real />}</div>;
      }
    `;
    const sizedCn = `
      export function Chart({ isLoading, wide }: { isLoading: boolean; wide: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className={cn('h-40', wide && 'w-full')} /> : <Real />}</div>;
      }
    `;
    // A forwarded prop among the arguments is where the height may come from,
    // so the call stays undecidable here and is judged at ITS call site.
    const forwardedCn = `
      export function Bar({ className }: { className?: string }) {
        return <Skeleton className={cn('w-full', className)} />;
      }
    `;
    // Inverted orientation: the height is the CONDITIONAL argument, so the bar
    // is 0px whenever the flag is false.
    const conditionalHeightCn = `
      export function Chart({ isLoading, expanded }: { isLoading: boolean; expanded: boolean }) {
        return <div>{isLoading ? <BlockSkeleton className={cn('w-full', expanded && 'h-40')} /> : <Real />}</div>;
      }
    `;
    expect(scanSource('flat-cn.tsx', flatCn).offenders.length).toBe(1);
    expect(scanSource('sized-cn.tsx', sizedCn).offenders).toEqual([]);
    expect(scanSource('forwarded-cn.tsx', forwardedCn).offenders).toEqual([]);
    expect(scanSource('conditional-height-cn.tsx', conditionalHeightCn).offenders.length).toBe(1);
  });

  it('accepts LoadingRows as a height-carrying placeholder', () => {
    // `LoadingRows` is the most-used placeholder here and carries full height;
    // a `Skeleton`-suffix-only tag test would report this branch.
    const withRows = `
      export function Panel({ isLoading }: { isLoading: boolean }) {
        return <section>{isLoading ? <><h2>Balances</h2><LoadingRows rows={4} /></> : <Real />}</section>;
      }
    `;
    expect(scanSource('loading-rows.tsx', withRows).offenders).toEqual([]);
  });

  it('exempts an inert control label and object property, but not a render prop', () => {
    // `isLoading`, not `isFetching`: the flag has to actually classify as a
    // loading condition, or Detector A never reaches the branch and the
    // control exemption is never exercised at all.
    const control = `
      export function More({ isLoading }: { isLoading: boolean }) {
        return <Button>{isLoading ? 'Loading older…' : 'Load more'}</Button>;
      }
    `;
    // Detector B's own control early-return, reached via bare JsxText.
    const controlText = `
      export function Refresh() {
        return <button type="button">Loading…</button>;
      }
    `;
    const objectProp = `
      export function Rows({ isLoading }: { isLoading: boolean }) {
        const cols = [{ label: isLoading ? 'Loading…' : 'Price' }];
        return <Table cols={cols} />;
      }
    `;
    // A control used as a full-width card wrapper must not exempt a placeholder
    // nested deep inside it, however tall that placeholder is.
    const controlAsWrapper = `
      export function Card({ isLoading }: { isLoading: boolean }) {
        return (
          <label className="flex border p-3">
            <section>{isLoading ? <p>Loading strategies…</p> : <Real />}</section>
          </label>
        );
      }
    `;
    // JSX in an attribute IS rendered — the host paints it as page content.
    const renderProp = `
      export function Form({ isLoading }: { isLoading: boolean }) {
        return <AutoForm aside={isLoading ? <p>Loading preview…</p> : <Preview />} />;
      }
    `;
    const pendingComponentProp = `
      export function Route() {
        return <Router pendingComponent={() => <p>Loading…</p>} />;
      }
    `;
    // A callback returning a STRING paints no height; reporting it would fail
    // CI on correct code with nothing to act on.
    const stringCell = `
      export function Table({ rows }: { rows: Row[] }) {
        const cols = [{ cell: (r) => (r.isLoading ? 'Loading…' : r.value) }];
        return <Grid cols={cols} rows={rows} />;
      }
    `;
    expect(scanSource('control.tsx', control).offenders).toEqual([]);
    expect(scanSource('control-text.tsx', controlText).offenders).toEqual([]);
    expect(scanSource('object-prop.tsx', objectProp).offenders).toEqual([]);
    expect(scanSource('string-cell.tsx', stringCell).offenders).toEqual([]);
    expect(scanSource('control-wrapper.tsx', controlAsWrapper).offenders.length).toBe(1);
    expect(scanSource('render-prop.tsx', renderProp).offenders.length).toBe(1);
    expect(scanSource('pending-prop.tsx', pendingComponentProp).offenders.length).toBe(1);
  });

  it('reports JSX bound to a local but not an inert string', () => {
    // A string binding paints nothing, so there is no placeholder to act on.
    const local = `
      export function Panel({ isLoading }: { isLoading: boolean }) {
        const label = isLoading ? 'Loading…' : 'Ready';
        return <Real label={label} />;
      }
    `;
    // JSX bound to a local IS painted by the slot that renders it, so hoisting
    // the branch out of the JSX must not hide it.
    const hoistedJsx = `
      export function Panel({ isLoading }: { isLoading: boolean }) {
        const body = isLoading ? <p>Please wait</p> : <List />;
        return <div>{body}</div>;
      }
    `;
    // Mixed arms: the string arm IS the 0px placeholder. Detector B cannot see
    // it either — the slot's child is the identifier `body`, not copy — so the
    // local-binding rule has to judge the whole value, not the branch alone.
    const mixedArms = `
      export function Panel({ isLoading, rows }: { isLoading: boolean; rows: Row[] }) {
        const body = isLoading ? 'Still fetching your trades' : <List rows={rows} />;
        return <div>{body}</div>;
      }
    `;
    expect(scanSource('local.tsx', local).offenders).toEqual([]);
    expect(scanSource('hoisted-jsx.tsx', hoistedJsx).offenders.length).toBe(1);
    expect(scanSource('mixed-arms.tsx', mixedArms).offenders.length).toBe(1);
  });

  it('throws instead of reporting clean when a file cannot be parsed', () => {
    // `createSourceFile` error-recovers rather than throwing, so a truncated
    // tree would otherwise be scanned as an offender-free file.
    expect(() => scanSource('broken.tsx', 'export function A() { return <div>;')).toThrow(
      /failed to parse/,
    );
  });

  it('every loading branch renders a height-carrying skeleton', () => {
    expect(existsSync(SRC_ROOT), `web source root missing at ${SRC_ROOT}`).toBe(true);

    const files = collectTsxFiles(SRC_ROOT);
    // A broken walk must fail loudly rather than report a clean tree.
    expect(files.length, 'TSX walk collected implausibly few files').toBeGreaterThanOrEqual(150);

    const seen = new Set<string>();
    const offenders: string[] = [];
    let loadingBranches = 0;

    for (const abs of files) {
      const rel = relative(resolve(HERE, '..', '..', '..'), abs)
        .split('\\')
        .join('/');
      const result = scanSource(rel, readFileSync(abs, 'utf8'));
      loadingBranches += result.loadingBranches;
      for (const o of result.offenders) {
        // Column included so two offenders on one line stay two entries.
        const key = `${o.file}:${o.line}:${o.column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offenders.push(key);
      }
    }

    expect(
      loadingBranches,
      'walker found implausibly few loading branches — the detector is likely broken',
    ).toBeGreaterThanOrEqual(30);

    expect(
      offenders,
      `loading branches rendering bare text instead of a skeleton:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
