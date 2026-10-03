import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/**
 * Documentation an agent can read to learn what a setting MEANS.
 *
 * The JSON Schema `list_strategies` returns gives types and bounds; it cannot say why a default is what it is, which settings interact, or which combination is a trap. These pages carry that, and they are served as MCP resources rather than tools so they cost nothing in the model's context until it actually opens one.
 *
 * The list is a closed constant and the only input the read path accepts is an entry's own URI. There is no caller-supplied path anywhere in this module: a traversal cannot be attempted because there is nothing to traverse with.
 */
export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
  /** Path relative to the docs root. Never combined with anything a caller sent. */
  readonly relativePath: string;
}

const strategyConcept = (name: string, title: string, description: string): McpResource => ({
  uri: `docs://concepts/strategies/${name}`,
  name: `${name}-concept`,
  title,
  description,
  mimeType: 'text/markdown',
  relativePath: `concepts/strategies/${name}.md`,
});

const configReference = (name: string, title: string, description: string): McpResource => ({
  uri: `docs://config/${name}`,
  name: `${name}-config-reference`,
  title,
  description,
  mimeType: 'text/markdown',
  relativePath: `_generated/config/${name}.md`,
});

export const MCP_RESOURCES: readonly McpResource[] = [
  strategyConcept(
    'trailing-trade',
    'Trailing-trade strategy',
    'How the grid-and-trail strategy decides to enter, add, and exit, in plain language.',
  ),
  strategyConcept(
    'momentum',
    'Momentum strategy',
    'How the momentum strategy picks entries, sets its protective stop, and trails an exit.',
  ),
  strategyConcept(
    'rebalance',
    'Rebalance strategy',
    'How the rebalance strategy holds a weighted basket and corrects drift.',
  ),
  configReference(
    'trailing-trade',
    'Trailing-trade settings reference',
    'Every trailing-trade setting with its default, bounds, and what changing it does.',
  ),
  configReference(
    'momentum',
    'Momentum settings reference',
    'Every momentum setting with its default, bounds, and what changing it does.',
  ),
  configReference(
    'rebalance',
    'Rebalance settings reference',
    'Every rebalance setting with its default, bounds, and what changing it does.',
  ),
  configReference(
    'discovery',
    'Symbol discovery settings reference',
    'Every automatic symbol-discovery setting and the filter it applies.',
  ),
  configReference(
    'risk',
    'Risk breaker settings reference',
    'Every risk limit, what trips it, and what happens while it is tripped.',
  ),
];

export const MCP_RESOURCES_BY_URI: ReadonlyMap<string, McpResource> = new Map(
  MCP_RESOURCES.map((resource) => [resource.uri, resource]),
);

/**
 * Reads one documentation resource off disk.
 *
 * The URI is looked up in the closed map first, so an unknown or crafted URI never reaches the filesystem. The resolved path is then re-checked against the docs root, which is redundant today and deliberately kept: the constants above are the only thing standing between this reader and an arbitrary file, and a future edit that makes `relativePath` even slightly dynamic should fail here rather than succeed quietly.
 *
 * @param uri - Resource URI, which must be one this module published.
 * @param docsRoot - Absolute path of the docs directory to read from.
 * @returns The file contents, or null when the URI is not one of ours or the file is missing.
 */
export const readMcpResource = async (
  uri: string,
  docsRoot: string,
): Promise<{ readonly resource: McpResource; readonly text: string } | null> => {
  const resource = MCP_RESOURCES_BY_URI.get(uri);
  if (!resource) return null;
  const root = resolve(docsRoot);
  const target = normalize(join(root, resource.relativePath));
  if (!isAbsolute(target) || (target !== root && !target.startsWith(root + sep))) return null;
  try {
    return { resource, text: await readFile(target, 'utf8') };
  } catch {
    // A docs page absent from the image is a packaging gap, not a caller error. Returning null lets the server answer "no such resource" instead of leaking the path it tried.
    return null;
  }
};
