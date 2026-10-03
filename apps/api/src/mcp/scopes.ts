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

/**
 * Asks the authorization server for a refresh token. It grants no tool access of its own.
 *
 * Without it an agent holds only a one-hour access token, and the refresh tokens it does get are revoked when the operator's browser session ends, so every agent has to be re-authorized by hand about once an hour. Revoking agent access, a password change, sign-out-everywhere and a restore all delete refresh-token rows, so this does not outlive any of those.
 */
export const MCP_OFFLINE_SCOPE = 'offline_access';

/** Every scope the authorization server accepts and the 401 challenge names: the tool scopes plus the refresh-token scope. The protected-resource document lists only the tool scopes, because the plugin keeps `offline_access` in authorization-server metadata. */
export const MCP_AUTHORIZATION_SCOPES: readonly string[] = [...MCP_SCOPES, MCP_OFFLINE_SCOPE];

/** How long an agent's refresh token stays usable, in seconds: 7 days. An agent idle longer than this is re-authorized by the operator, so a leaked refresh token cannot hold trading authority for the library's 30-day default. */
export const MCP_REFRESH_TOKEN_TTL_SECONDS: number = 7 * 24 * 60 * 60;
