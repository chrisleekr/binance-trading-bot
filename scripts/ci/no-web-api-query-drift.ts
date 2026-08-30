import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectOrExit } from './lib/walk.mjs';

import { API } from 'typescript/unstable/async';
import * as ts from 'typescript/unstable/ast';
import type {
  CallExpression,
  Expression,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
} from 'typescript/unstable/ast';

interface SourceContext {
  readonly file: string;
  readonly source: SourceFile;
}

interface CanonicalUse {
  readonly file: string;
  readonly keys: ReadonlySet<string>;
  readonly line: number;
  readonly method: string;
  readonly path: string;
}

interface ApiOperation {
  readonly file: string;
  readonly keys: ReadonlySet<string>;
  readonly method: string;
  readonly path: string;
}

interface ApiBindings {
  readonly helpers: ReadonlySet<ApiHelper>;
  readonly apiModuleImported: boolean;
}

interface QueryKeys {
  readonly keys: ReadonlySet<string>;
  readonly violations: readonly string[];
}

type ApiHelper = 'apiDownloadUrl' | 'apiFetch';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const guardRoot = resolve(process.env['GUARD_ROOT'] ?? repoRoot);
const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.turbo'];
const isRuntimeSource = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path);
const anchors: readonly string[] = [
  'apps/web/src/main.tsx',
  'apps/web/src/shared/lib/api.ts',
  'apps/web/src/features/backtest/api/backtest.ts',
  'apps/web/src/features/profile/api/profile-logs.ts',
];
/**
 * Narrows a source name to one of the two query-aware API helpers.
 * @param name - Imported or called source name being classified.
 * @returns Whether the name is part of the canonical query API.
 */
const isApiHelper = (name: string): name is ApiHelper =>
  name === 'apiDownloadUrl' || name === 'apiFetch';

/**
 * Removes syntax-only wrappers without evaluating a caller-owned expression.
 * @param expression - Expression that may carry parentheses or type-only wrappers.
 * @returns The underlying runtime expression.
 */
const unwrap = (expression: Expression): Expression => {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * Recognizes a reference used as the immediate call target, without accepting wrappers or method indirection.
 * @param node - Candidate helper or global request reference.
 * @returns Whether the parent invokes this exact expression directly.
 */
const isDirectCallTarget = (node: Node): boolean =>
  ts.isCallExpression(node.parent) && node.parent.expression === node;

/**
 * Recognizes the browser's global fetch spellings while excluding unrelated object methods named fetch.
 * @param node - Candidate request expression.
 * @returns Whether the expression names global fetch directly.
 */
const isGlobalFetch = (node: Node): node is Expression => {
  if (ts.isIdentifier(node)) {
    if (node.text !== 'fetch') return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    return true;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'globalThis' || node.expression.text === 'window')
  ) {
    return node.name.text === 'fetch';
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'globalThis' || node.expression.text === 'window') &&
    node.argumentExpression
  ) {
    const key = unwrap(node.argumentExpression);
    return ts.isStringLiteral(key) && key.text === 'fetch';
  }
  return false;
};

/**
 * Reads a property name only when source text makes the name static.
 * @param node - Property-name node to classify.
 * @returns The literal property name, otherwise null.
 */
const propertyName = (node: Node | undefined): string | null => {
  if (!node) return null;
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : null;
};

/**
 * Finds one explicitly assigned object property without following spreads or aliases.
 * @param object - Canonical inline object being read.
 * @param name - Property name required by the canonical form.
 * @returns The matching property assignment, otherwise null.
 */
const assignedProperty = (
  object: ObjectLiteralExpression,
  name: string,
): PropertyAssignment | null => {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property;
  }
  return null;
};

/**
 * Produces stable one-based locations for actionable diagnostics.
 * @param source - Source file containing the node.
 * @param node - Node whose start line is requested.
 * @returns The one-based source line.
 */
const lineOf = (source: SourceFile, node: Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/**
 * Formats one source-owned canonical-form violation.
 * @param context - File and parsed source owning the violation.
 * @param node - Node where the unsupported form begins.
 * @param message - Stable explanation of the rejected form.
 * @returns A file, line, and reason diagnostic.
 */
const diagnostic = (context: SourceContext, node: Node, message: string): string =>
  context.file + ':' + lineOf(context.source, node) + ' ' + message;

/**
 * Recognizes the shared API module without depending on one import alias spelling.
 * @param specifier - Module specifier from a web import.
 * @returns Whether it resolves by convention to shared/lib/api.
 */
const isApiModule = (specifier: string): boolean =>
  /(?:^|\/)shared\/lib\/api(?:\.js)?$/.test(specifier);

/**
 * Enforces direct helper imports so aliases and namespaces cannot hide query calls from the finite scanner.
 * @param context - Parsed web source whose imports are being checked.
 * @param violations - Mutable diagnostic sink for unsupported bindings.
 * @returns Which canonical helpers are directly imported.
 */
const collectBindings = (context: SourceContext, violations: string[]): ApiBindings => {
  const helpers = new Set<ApiHelper>();
  let apiModuleImported = false;
  const reject = (node: Node, message: string): void => {
    violations.push(diagnostic(context, node, message));
  };
  for (const statement of context.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!isApiModule(statement.moduleSpecifier.text)) continue;
    apiModuleImported = true;
    const clause = statement.importClause;
    if (clause?.name) {
      reject(clause.name, 'unsupported default API helper import');
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      reject(bindings, 'unsupported API helper namespace import; import helpers directly');
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (!isApiHelper(imported)) continue;
      if (element.name.text !== imported) {
        reject(element, `unsupported ${imported} import alias; use the canonical name`);
        continue;
      }
      helpers.add(imported);
    }
  }
  return { helpers, apiModuleImported };
};

/**
 * Reduces a direct literal, template, or accountPath call to a finite path shape.
 * @param expression - Path expression supplied directly to a canonical helper.
 * @returns A path with runtime segments represented as braces, otherwise null.
 */
const pathShape = (expression: Expression): string | null => {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let path = node.head.text;
    for (const span of node.templateSpans) path += '{}' + span.literal.text;
    return path;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'accountPath' &&
    node.arguments[0]
  ) {
    const relativePath = pathShape(node.arguments[0]);
    if (relativePath === null) return null;
    return '/accounts/{}' + (relativePath.startsWith('/') ? relativePath : '/' + relativePath);
  }
  return null;
};

/**
 * Normalizes API path spelling so web calls and mounted operations share one identity.
 * @param rawPath - Finite path shape from source or OpenAPI.
 * @returns Slash-normalized path with every runtime segment represented as braces.
 */
const canonicalPath = (rawPath: string): string => {
  let path = rawPath.trim();
  if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  path = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return path
    .split('/')
    .map((segment) => (/^\{[^}]*\}$/.test(segment) || /^:[\w]+$/.test(segment) ? '{}' : segment))
    .join('/');
};

/**
 * Applies apiFetch and apiDownloadUrl base semantics to a finite caller path.
 * @param expression - Direct canonical helper path argument.
 * @returns The canonical mounted API path, otherwise null.
 */
const canonicalApiPath = (expression: Expression): string | null => {
  const shape = pathShape(expression);
  if (shape === null) return null;
  const path = canonicalPath(shape);
  return path === '/api' || path.startsWith('/api/')
    ? path
    : canonicalPath('/api' + (path.startsWith('/') ? path : '/' + path));
};

/**
 * Finds the nearest function or source-file owner for local syntax checks.
 * @param node - Node whose lexical owner is requested.
 * @returns The nearest function-like node or the source file.
 */
const ownerOf = (node: Node): Node => {
  let current = node.parent;
  while (
    current &&
    !ts.isSourceFile(current) &&
    !ts.isFunctionDeclaration(current) &&
    !ts.isFunctionExpression(current) &&
    !ts.isArrowFunction(current) &&
    !ts.isMethodDeclaration(current)
  ) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
};

/**
 * Distinguishes API syntax from TanStack and other SPA navigation expressions.
 * @param text - Source text for one URL expression.
 * @returns Whether the expression names the API namespace or a canonical API path helper.
 */
const hasApiSyntax = (text: string): boolean =>
  text.includes('/api') || text.includes('accountPath(') || text.includes('apiDownloadUrl(');

/**
 * Finds query punctuation only inside URL literal fragments so conditional operators remain ordinary control flow.
 * @param node - URL syntax subtree whose literals are inspected.
 * @returns Whether a string or template fragment contains a question mark.
 */
const hasQueryLiteral = (node: Node): boolean => {
  let found = false;
  const visit = (candidate: Node): void => {
    if (found) return;
    if (
      ts.isStringLiteral(candidate) ||
      ts.isNoSubstitutionTemplateLiteral(candidate) ||
      ts.isTemplateHead(candidate) ||
      ts.isTemplateMiddle(candidate) ||
      ts.isTemplateTail(candidate)
    ) {
      found = candidate.text.includes('?');
      if (found) return;
    }
    candidate.forEachChild(visit);
  };
  visit(node);
  return found;
};

/**
 * Checks whether a protocol expression explicitly selects both WebSocket schemes.
 * @param node - Right-hand side of a URL protocol assignment.
 * @returns Whether both ws and wss literal branches are present.
 */
const isWebSocketProtocolSwitch = (node: Node): boolean => {
  const schemes = new Set<string>();
  const visit = (candidate: Node): void => {
    if (ts.isStringLiteral(candidate)) schemes.add(candidate.text);
    candidate.forEachChild(visit);
  };
  visit(node);
  return schemes.has('ws:') && schemes.has('wss:');
};

/**
 * Excludes only the URL receiver proven to be the owner's single WebSocket endpoint builder.
 * @param node - URL.searchParams mutation under consideration.
 * @returns Whether this immutable receiver is initialized with a static /ws path and converted to ws or wss.
 */
const isWebSocketMutation = (node: CallExpression): boolean => {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isPropertyAccessExpression(node.expression.expression)
  ) {
    return false;
  }
  const receiver = unwrap(node.expression.expression.expression);
  if (!ts.isIdentifier(receiver)) return false;

  const owner = ownerOf(node);
  let declarations = 0;
  let webSocketInitializer = false;
  let protocolSwitch = false;
  const visit = (candidate: Node): void => {
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === receiver.text
    ) {
      declarations += 1;
      const initializer = candidate.initializer ? unwrap(candidate.initializer) : null;
      const declarationList = candidate.parent;
      if (
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        initializer &&
        ts.isNewExpression(initializer) &&
        initializer.arguments?.[0]
      ) {
        const path = pathShape(initializer.arguments[0]);
        if (path !== null && canonicalPath(path).endsWith('/ws')) webSocketInitializer = true;
      }
    }
    if (
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(candidate.left) &&
      candidate.left.name.text === 'protocol'
    ) {
      const protocolReceiver = unwrap(candidate.left.expression);
      if (
        ts.isIdentifier(protocolReceiver) &&
        protocolReceiver.text === receiver.text &&
        isWebSocketProtocolSwitch(candidate.right)
      ) {
        protocolSwitch = true;
      }
    }
    candidate.forEachChild(visit);
  };
  visit(owner);
  return declarations === 1 && webSocketInitializer && protocolSwitch;
};

/**
 * Enumerates query keys only from an inline object with static property names.
 * @param expression - Query initializer from a canonical helper call.
 * @param context - Source owner used for diagnostics.
 * @returns Static keys and every unsupported property form.
 */
const staticQueryKeys = (expression: Expression, context: SourceContext): QueryKeys => {
  const node = unwrap(expression);
  if (!ts.isObjectLiteralExpression(node)) {
    return {
      keys: new Set(),
      violations: [diagnostic(context, node, 'query must be an inline object literal')],
    };
  }
  const keys = new Set<string>();
  const violations: string[] = [];
  const reject = (node: Node, message: string): void => {
    violations.push(diagnostic(context, node, message));
  };
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      reject(property, 'spread query keys are unsupported');
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name === null) {
        reject(property, 'computed query keys are unsupported');
      } else {
        keys.add(name);
      }
      continue;
    }
    reject(property, 'query object must contain static property assignments');
  }
  return { keys, violations };
};

/**
 * Collects one direct canonical query helper call without evaluating caller-owned helpers.
 * @param call - Direct apiFetch or apiDownloadUrl call under inspection.
 * @param context - Source owner used for path and diagnostics.
 * @param bindings - Direct helper imports available in the source.
 * @param uses - Mutable canonical-use sink.
 * @param violations - Mutable unsupported-form sink.
 */
const collectCanonicalCall = (
  call: CallExpression,
  context: SourceContext,
  bindings: ApiBindings,
  uses: CanonicalUse[],
  violations: string[],
): void => {
  if (!ts.isIdentifier(call.expression)) return;
  const helper = call.expression.text;
  if (!isApiHelper(helper)) return;
  const reject = (node: Node, message: string): void => {
    violations.push(diagnostic(context, node, message));
  };
  if (!bindings.helpers.has(helper)) {
    reject(call, `${helper} must be directly imported from shared/lib/api`);
    return;
  }
  const pathExpression = call.arguments[0];
  if (!pathExpression) return;
  if (hasQueryLiteral(pathExpression)) {
    reject(pathExpression, 'raw query strings are unsupported; use a static query object');
  }

  let method = 'GET';
  let queryExpression = call.arguments[1];
  if (helper === 'apiFetch') {
    const rawOptions = call.arguments[2];
    if (!rawOptions) return;
    const options = unwrap(rawOptions);
    if (!ts.isObjectLiteralExpression(options)) {
      reject(options, 'apiFetch options must be an inline object literal');
      return;
    }
    for (const property of options.properties) {
      if (ts.isSpreadAssignment(property) || propertyName(property.name) === null) {
        reject(property, 'apiFetch options cannot use spreads or computed names');
      }
    }
    const queryMember = options.properties.find(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        propertyName(property.name) === 'query',
    );
    if (!queryMember) return;
    if (!ts.isPropertyAssignment(queryMember)) {
      reject(queryMember, 'query must be an explicit inline object literal');
      return;
    }
    queryExpression = queryMember.initializer;
    const methodProperty = assignedProperty(options, 'method');
    const methodValue = methodProperty ? unwrap(methodProperty.initializer) : null;
    if (
      !methodValue ||
      (!ts.isStringLiteral(methodValue) && !ts.isNoSubstitutionTemplateLiteral(methodValue))
    ) {
      reject(
        methodValue ?? options,
        'query-bearing apiFetch requires an explicit literal HTTP method',
      );
      return;
    }
    method = methodValue.text.toUpperCase();
  }
  if (!queryExpression) {
    reject(call, 'apiDownloadUrl requires a direct path and static query object');
    return;
  }

  const queryKeys = staticQueryKeys(queryExpression, context);
  violations.push(...queryKeys.violations);
  const path = canonicalApiPath(pathExpression);
  if (path === null) {
    reject(pathExpression, 'API path must be a direct static path expression');
  }
  if (queryKeys.violations.length === 0 && path !== null) {
    uses.push({
      file: context.file,
      keys: queryKeys.keys,
      line: lineOf(context.source, call),
      method,
      path,
    });
  }
};

/**
 * Detects canonical calls and every explicitly unsupported query-bearing API form in one file.
 * @param context - Parsed web source being scanned.
 * @param uses - Mutable canonical-use sink.
 * @param violations - Mutable unsupported-form sink.
 */
const scanWebSource = (
  context: SourceContext,
  uses: CanonicalUse[],
  violations: string[],
): void => {
  const bindings = collectBindings(context, violations);
  const reject = (node: Node, message: string): void => {
    violations.push(diagnostic(context, node, message));
  };
  const ownerHasApiContext = (node: Node): boolean => {
    const text = ownerOf(node).getText(context.source);
    return (
      bindings.apiModuleImported ||
      text.includes('apiFetch') ||
      text.includes('apiDownloadUrl') ||
      text.includes('accountPath') ||
      /\/api(?:\/|['"])/.test(text)
    );
  };
  const rejectAlternateDownload = (expression: Expression): void => {
    const text = expression.getText(context.source);
    if (
      hasApiSyntax(text) &&
      hasQueryLiteral(expression) &&
      !text.trimStart().startsWith('apiDownloadUrl(')
    ) {
      reject(expression, 'alternate API download URL is unsupported; use apiDownloadUrl');
    }
  };
  const visit = (node: Node): void => {
    if (
      ts.isIdentifier(node) &&
      isApiHelper(node.text) &&
      bindings.helpers.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !isDirectCallTarget(node)
    ) {
      reject(node, `unsupported indirect ${node.text} reference; call it directly`);
    }

    if (
      context.file !== 'apps/web/src/shared/lib/api.ts' &&
      isGlobalFetch(node) &&
      !isDirectCallTarget(node)
    ) {
      reject(node, 'unsupported indirect global fetch reference; call fetch directly');
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      rejectAlternateDownload(node.initializer);
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URLSearchParams' &&
      context.file !== 'apps/web/src/shared/lib/api.ts' &&
      ownerHasApiContext(node)
    ) {
      reject(node, 'URLSearchParams is unsupported for HTTP API calls; use a static query object');
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'set' || node.expression.name.text === 'append') &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'searchParams' &&
      !isWebSocketMutation(node) &&
      ownerHasApiContext(node)
    ) {
      reject(node, 'URL.searchParams mutation is unsupported for HTTP API URLs');
    }

    if (ts.isCallExpression(node) && node.arguments[0]) {
      const target = node.expression.getText(context.source);
      const requestText = node.arguments[0].getText(context.source);
      if (context.file !== 'apps/web/src/shared/lib/api.ts' && isGlobalFetch(node.expression)) {
        const request = unwrap(node.arguments[0]);
        const inlineUrl =
          ts.isStringLiteral(request) ||
          ts.isNoSubstitutionTemplateLiteral(request) ||
          ts.isTemplateExpression(request);
        if (!inlineUrl || hasQueryLiteral(request)) {
          reject(
            node,
            'raw fetch URL must be an inline query-free literal or template; use apiFetch for API queries',
          );
        }
      }
      if (
        target === 'window.open' &&
        hasApiSyntax(requestText) &&
        hasQueryLiteral(node.arguments[0])
      ) {
        reject(node, 'alternate API navigation sink is unsupported; use apiDownloadUrl');
      }
    }

    if (ts.isReturnStatement(node) && node.expression) rejectAlternateDownload(node.expression);

    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) rejectAlternateDownload(node.body);

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left.getText(context.source);
      if (target.endsWith('.href') || target.endsWith('.location')) {
        rejectAlternateDownload(node.right);
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (isApiHelper(node.expression.text)) {
        collectCanonicalCall(node, context, bindings, uses, violations);
      }
    }
    node.forEachChild(visit);
  };
  context.source.forEachChild(visit);
};

/**
 * Indexes createRoute method/path pairs so mounted operations can name their source owner.
 * @param contexts - Parsed API route source files.
 * @returns Every statically declared route identity and its file.
 */
const routeDefinitions = (contexts: readonly SourceContext[]): ApiOperation[] => {
  const definitions: ApiOperation[] = [];
  for (const context of contexts) {
    const visit = (node: Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createRoute' &&
        node.arguments[0]
      ) {
        const config = unwrap(node.arguments[0]);
        if (ts.isObjectLiteralExpression(config)) {
          const method = assignedProperty(config, 'method');
          const path = assignedProperty(config, 'path');
          const methodValue = method ? unwrap(method.initializer) : null;
          const pathValue = path ? unwrap(path.initializer) : null;
          if (
            methodValue &&
            pathValue &&
            (ts.isStringLiteral(methodValue) || ts.isNoSubstitutionTemplateLiteral(methodValue)) &&
            (ts.isStringLiteral(pathValue) || ts.isNoSubstitutionTemplateLiteral(pathValue))
          ) {
            definitions.push({
              file: context.file,
              keys: new Set(),
              method: methodValue.text.toUpperCase(),
              path: canonicalPath(pathValue.text),
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    context.source.forEachChild(visit);
  }
  return definitions;
};

/**
 * Maps a mounted operation back to its unique createRoute source.
 * @param method - Mounted HTTP method.
 * @param path - Mounted canonical API path.
 * @param definitions - Source-declared route identities.
 * @returns The unique source file, otherwise null.
 */
const sourceForOperation = (
  method: string,
  path: string,
  definitions: readonly ApiOperation[],
): string | null => {
  const files = new Set(
    definitions
      .filter(
        (definition) =>
          definition.method === method &&
          (path === definition.path || path.endsWith(definition.path)),
      )
      .map((definition) => definition.file),
  );
  return files.size === 1 ? [...files][0] : null;
};

/**
 * Narrows unknown OpenAPI nodes before reading their fields.
 * @param value - Runtime document value under inspection.
 * @returns Whether it is a non-null record.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Generates the mounted OpenAPI document with an inert registration-only DI and extracts query contracts.
 * @param definitions - Source route identities used to attach diagnostics to API files.
 * @returns Every mounted operation and its declared query keys.
 */
const mountedOperations = async (definitions: readonly ApiOperation[]): Promise<ApiOperation[]> => {
  const { createApiHono } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/src/types.ts')).href
  );
  const { mountApiRouters } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/src/routes/mount.ts')).href
  );
  const { OPENAPI_DOC } = await import(
    pathToFileURL(join(repoRoot, 'apps/api/src/routes/docs.ts')).href
  );
  const app = createApiHono();
  // Router factories capture DI in handlers but do not read it while registering routes, so Reflect.apply supplies an inert runtime value without weakening the production signature.
  Reflect.apply(mountApiRouters, undefined, [app, Object.freeze({})]);
  const document = app.getOpenAPI31Document(OPENAPI_DOC);
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!isRecord(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      const upperMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod)) continue;
      if (!isRecord(operation)) continue;
      const canonical = canonicalPath(path);
      const file = sourceForOperation(upperMethod, canonical, definitions);
      if (!file)
        throw new Error('cannot resolve API source for mounted ' + upperMethod + ' ' + path);
      const parameters = Array.isArray(operation['parameters']) ? operation['parameters'] : [];
      operations.push({
        file,
        keys: new Set(
          parameters
            .filter(isRecord)
            .filter((parameter) => parameter['in'] === 'query')
            .map((parameter) => parameter['name'])
            .filter((name): name is string => typeof name === 'string'),
        ),
        method: upperMethod,
        path: canonical,
      });
    }
  }
  return operations;
};

const webFiles = collectOrExit({
  root: guardRoot,
  label: 'web runtime source files',
  skipDirs: SKIP_DIRS,
  test: isRuntimeSource,
  roots: [{ name: 'apps/web/src', anchors }],
}).sort();

// Rooted at repoRoot rather than guardRoot, so unlike the web walk above these two stops cannot be driven from the self-test: mountedOperations imports the real API modules by repoRoot URL below, and pointing the walk at a fixture would desync the two halves. They are proven by the real run only, which is weaker than this repo's usual bar and is written here rather than left to be inferred from the absence of a fixture.
//
// The route walk is what the web side is judged AGAINST, so a narrowing here is not merely a smaller scan: every operation it fails to parse turns real call sites into `unresolved mounted operation` noise, and the reader is told the web code drifted when the truth is that the walk did. It floors on the two modules the parse is already anchored on by URL below.
const apiFiles = collectOrExit({
  root: repoRoot,
  label: 'API route source files',
  skipDirs: SKIP_DIRS,
  test: isRuntimeSource,
  roots: [
    {
      name: 'apps/api/src/routes',
      anchors: ['apps/api/src/routes/mount.ts', 'apps/api/src/routes/docs.ts'],
    },
  ],
}).sort();
const compiler = new API({ cwd: repoRoot });
const snapshot = await compiler.updateSnapshot({ openFiles: [...webFiles, ...apiFiles] });

/**
 * Loads one source through the shared compiler snapshot so parent links are available.
 * @param file - Absolute TypeScript source path.
 * @param base - Base path used for stable diagnostics.
 * @returns Parsed source and its relative file name.
 */
const loadContext = async (file: string, base: string): Promise<SourceContext> => {
  const project = await snapshot.getDefaultProjectForFile(file);
  const source = project ? await project.program.getSourceFile(file) : null;
  if (!source) throw new Error('TypeScript AST did not load ' + file);
  return { file: relative(base, file).split(sep).join('/'), source };
};

try {
  const webContexts = await Promise.all(webFiles.map((file) => loadContext(file, guardRoot)));
  const apiContexts = await Promise.all(apiFiles.map((file) => loadContext(file, repoRoot)));
  const definitions = routeDefinitions(apiContexts);
  if (definitions.length === 0) throw new Error('zero createRoute definitions parsed');
  const operations = await mountedOperations(definitions);
  if (operations.length === 0) throw new Error('zero mounted OpenAPI operations parsed');

  const uses: CanonicalUse[] = [];
  const violations: string[] = [];
  for (const context of webContexts) scanWebSource(context, uses, violations);
  if (uses.length === 0 && violations.length === 0) {
    console.error('no-web-api-query-drift: zero query-bearing HTTP API sites found');
    process.exit(1);
  }

  for (const use of uses) {
    const operation = operations.find(
      (candidate) => candidate.method === use.method && candidate.path === use.path,
    );
    const location = use.file + ':' + use.line;
    if (!operation) {
      violations.push(location + ' unresolved mounted operation ' + use.method + ' ' + use.path);
      continue;
    }
    for (const key of use.keys) {
      if (!operation.keys.has(key)) {
        violations.push(
          location +
            ' ' +
            use.method +
            ' ' +
            use.path +
            ' sends undeclared query key "' +
            key +
            '"; API operation: ' +
            operation.file,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error('Web/API query canonical-form violations:');
    for (const violation of [...new Set(violations)].sort()) console.error(violation);
    process.exit(1);
  }

  console.log(
    'no-web-api-query-drift: query-bearing HTTP API sites: ' +
      uses.length +
      '; sent keys: ' +
      uses.reduce((sum, use) => sum + use.keys.size, 0),
  );
} finally {
  await compiler.close();
}
