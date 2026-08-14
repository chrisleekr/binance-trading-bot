#!/usr/bin/env bash
set -euo pipefail
# Bidirectional environment contract gate. Declared .env.example keys need a
# source consumer, and supported runtime/build reads need an ENV_CATALOGUE entry
# or one exact reviewed exclusion.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-phantom-env-var

repo_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$repo_root}"
cd "$repo_root"

GUARD_ROOT="$GUARD_ROOT" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const ts = await import("typescript/unstable/ast");
const { API } = await import("typescript/unstable/async");
const root = process.env.GUARD_ROOT;

const INFRA_ONLY = new Set([
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "APP_HTTP_PORT",
  "IMAGE_TAG",
  "WORKER_REPLICAS",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);

// Test and tooling inputs are intentionally outside the operator contract.
const READ_EXCLUSIONS = new Map([
  ["DATABASE_TEST_URL", new Set(["packages/testcontainers/src/index.ts"])],
  ["REDIS_TEST_URL", new Set(["packages/testcontainers/src/index.ts"])],
  ["TESTCONTAINERS", new Set(["packages/testcontainers/src/index.ts"])],
  ["API_PROXY_TARGET", new Set(["apps/web/vite.config.ts"])],
  ["ADMIN_DATABASE_URL", new Set(["packages/db/drizzle.config.ts"])],
  ["npm_package_version", new Set([
    "packages/observability/src/index.ts",
    "packages/observability/src/otel.ts",
  ])],
  ["APP_E2E", new Set([
    "apps/api/src/env.ts",
    "packages/binance/src/endpoints.ts",
  ])],
  ["BINANCE_REST_URL", new Set(["packages/binance/src/endpoints.ts"])],
  ["BINANCE_MARKET_WS_URL", new Set(["packages/binance/src/endpoints.ts"])],
  ["BINANCE_USER_WS_URL", new Set(["packages/binance/src/endpoints.ts"])],
  ["COVERAGE_LANE", new Set(["apps/web/vitest.config.ts"])],
]);
const DYNAMIC_READ_EXCLUSIONS = new Set(["packages/core/src/env/load-env.ts"]);

const envPath = path.join(root, ".env.example");
const envText = fs.readFileSync(envPath, "utf8");
const declared = [...new Set(
  envText.split(/\r?\n/)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean),
)];
if (declared.length === 0) {
  console.error("no declared keys parsed from .env.example — parser regression in this gate.");
  process.exit(1);
}

const SKIP_DIR = new Set(["node_modules", "dist", "__tests__"]);
const tsFiles = (directory, out = []) => {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) tsFiles(file, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
};
const files = [
  ...tsFiles(path.join(root, "apps")),
  ...tsFiles(path.join(root, "packages")),
];
if (files.length === 0) {
  console.error("no TS files found under apps/ or packages/ — scan-path regression in this gate.");
  process.exit(1);
}

const catalogPath = path.join(root, "packages", "core", "src", "env", "catalogue.ts");
if (!fs.existsSync(catalogPath)) {
  console.error("packages/core/src/env/catalogue.ts not found — catalogue path regression in this gate.");
  process.exit(1);
}
const api = new API({ cwd: root });
const snapshot = await api.updateSnapshot({ openFiles: [...files, catalogPath] });
const sourceContextOf = async (file) => {
  const project = await snapshot.getDefaultProjectForFile(file);
  if (!project) return null;
  const source = await project.program.getSourceFile(file);
  return source === null ? null : { source, checker: project.checker };
};
const catalogContext = await sourceContextOf(catalogPath);
if (catalogContext === null) {
  console.error("ENV_CATALOGUE source was not loaded by the TypeScript AST — parser regression in this gate.");
  process.exit(1);
}
const catalogSource = catalogContext.source;
const unwrap = (node) => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
};
let catalogueObject = null;
const findCatalogue = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ENV_CATALOGUE" && node.initializer) {
    const value = unwrap(node.initializer);
    if (ts.isObjectLiteralExpression(value)) catalogueObject = value;
  }
  node.forEachChild(findCatalogue);
};
findCatalogue(catalogSource);
if (catalogueObject === null) {
  console.error("ENV_CATALOGUE object not found — catalogue parser regression in this gate.");
  process.exit(1);
}
const catalogued = new Set();
for (const property of catalogueObject.properties) {
  if (!property.name) continue;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) catalogued.add(property.name.text);
}
if (catalogued.size === 0) {
  console.error("zero ENV_CATALOGUE keys parsed — catalogue parser regression in this gate.");
  process.exit(1);
}

const isProcessEnv = (node) => {
  const value = unwrap(node);
  return ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) && value.expression.text === "process" && value.name.text === "env";
};
const isImportMetaEnv = (node) => {
  const value = unwrap(node);
  return ts.isPropertyAccessExpression(value) &&
    ts.isMetaProperty(unwrap(value.expression)) &&
    unwrap(value.expression).keywordToken === ts.SyntaxKind.ImportKeyword &&
    value.name.text === "env";
};
const isEnvObject = (node) => isProcessEnv(node) || isImportMetaEnv(node);
const propertyKey = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = unwrap(node.argumentExpression);
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? argument.text
      : null;
  }
  return null;
};

const reads = [];
const typedDynamicReads = [];
for (const file of files) {
  const context = await sourceContextOf(file);
  if (context === null) {
    console.error("TypeScript AST did not load " + path.relative(root, file));
    process.exit(1);
  }
  const { source, checker } = context;
  const isEnvInitializer = (node) => {
    if (isEnvObject(node)) return true;
    const value = unwrap(node);
    return ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      (isEnvObject(value.left) || isEnvObject(value.right));
  };
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  const scopes = [];
  const startsScope = (node) =>
    ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
  const aliasValue = (name) => {
    for (let index = scopes.length - 1; index >= 0; index--) {
      if (scopes[index].has(name)) return scopes[index].get(name);
    }
    return false;
  };

  const visit = (node) => {
    const scoped = startsScope(node);
    if (scoped) scopes.push(new Map());
    if ((ts.isVariableDeclaration(node) || ts.isParameterDeclaration(node)) && ts.isIdentifier(node.name)) {
      const typeText = node.type ? source.text.slice(node.type.pos, node.type.end) : "";
      const initial = node.initializer ? unwrap(node.initializer) : null;
      scopes.at(-1).set(
        node.name.text,
        typeText.includes("NodeJS.ProcessEnv") || Boolean(initial && isEnvInitializer(initial)),
      );
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const initial = unwrap(node.initializer);
      const direct = isEnvInitializer(initial);
      const aliased = ts.isIdentifier(initial) && aliasValue(initial.text);
      if (direct || aliased) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken) {
            console.error("environment destructuring rest is not supported at " + relativeFile);
            process.exit(1);
          }
          const keyNode = element.propertyName ?? element.name;
          if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode)) {
            console.error("dynamic environment destructuring is not supported at " + relativeFile);
            process.exit(1);
          }
          reads.push({ key: keyNode.text, file: relativeFile });
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = unwrap(node.expression);
      const direct = isEnvObject(base);
      const aliased = ts.isIdentifier(base) && aliasValue(base.text);
      if (direct || aliased) {
        const key = propertyKey(node);
        if (key !== null) reads.push({ key, file: relativeFile });
        else if (ts.isElementAccessExpression(node) && !DYNAMIC_READ_EXCLUSIONS.has(relativeFile)) {
          typedDynamicReads.push({ argument: node.argumentExpression, checker, file: relativeFile });
        }
      }
    }
    node.forEachChild(visit);
    if (scoped) scopes.pop();
  };
  visit(source);
}

for (const read of typedDynamicReads) {
  const type = await read.checker.getTypeAtLocation(read.argument);
  const members = type.isUnionType() ? await type.getTypes() : [type];
  if (members.length === 0 || !members.every((member) => member.isStringLiteralType())) {
    console.error("dynamic environment read is not supported at " + read.file);
    process.exit(1);
  }
  for (const member of members) reads.push({ key: member.value, file: read.file });
}
if (reads.length === 0) {
  console.error("zero environment reads found — AST scan regression in this gate.");
  process.exit(1);
}

const reverseGaps = [];
const seenGap = new Set();
for (const read of reads) {
  if (catalogued.has(read.key) || READ_EXCLUSIONS.get(read.key)?.has(read.file)) continue;
  const id = read.key + "\0" + read.file;
  if (!seenGap.has(id)) {
    seenGap.add(id);
    reverseGaps.push(read);
  }
}
if (reverseGaps.length > 0) {
  console.error("Environment reads absent from ENV_CATALOGUE and the reviewed exclusion set:");
  for (const gap of reverseGaps) console.error("  " + gap.key + " at " + gap.file);
  process.exit(1);
}

// Keep the original declared-to-reader direction. Whole-word source matching is
// intentional here because zod schema keys consume the raw environment without
// property access at the declaration site.
const corpus = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const pending = declared.filter((key) => !INFRA_ONLY.has(key));
const found = new Set(pending.filter((key) => new RegExp("\\b" + key + "\\b").test(corpus)));
if (found.size === 0) {
  console.error("zero env-var readers resolved across all non-allowlisted keys — scan regression in this gate.");
  process.exit(1);
}
const phantoms = pending.filter((key) => !found.has(key));
if (phantoms.length > 0) {
  console.error("Phantom env vars (declared in .env.example, no app reader, not infra-only):");
  console.error(phantoms.map((key) => "  " + key).join("\n"));
  process.exit(1);
}

await snapshot.dispose();
await api.close();

console.log(
  "no-phantom-env-var gate: OK (" + declared.length + " declared keys, " +
    reads.length + " AST reads, " + catalogued.size + " catalogue keys)",
);
'
