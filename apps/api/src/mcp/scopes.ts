/**
 * The two scopes the MCP authorization server issues.
 *
 * The split is the whole point of the consent screen: an agent that only reads the dashboard never holds the scope that can place an order, so a prompt-injected instruction in a market commentary it read cannot reach the trading surface with a read-only token. `mcp:read` covers every GET plus the two dry-run POSTs that write nothing, and `mcp:trade` covers everything that moves money or configuration.
 */
export const MCP_SCOPE_READ = 'mcp:read';
export const MCP_SCOPE_TRADE = 'mcp:trade';

export type McpScope = typeof MCP_SCOPE_READ | typeof MCP_SCOPE_TRADE;

/** Advertised in the protected-resource metadata and offered on the consent screen, in escalating order so the prompt reads least-privilege first. */
export const MCP_SCOPES: readonly McpScope[] = [MCP_SCOPE_READ, MCP_SCOPE_TRADE];
