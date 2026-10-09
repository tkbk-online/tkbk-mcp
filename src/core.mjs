// Shared pieces of the TKBK MCP servers: an HTTP client with timeouts and readable errors,
// a compact output for agents (tokens are money), and the server builder with a confirmation gate for writes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export { z };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** JSON request with a timeout. The service's error text is kept short and never contains our credentials. */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ApiError(0, `service is not reachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? data.message || data.detail || data.title || data.error?.message || data.error_description || JSON.stringify(data).slice(0, 300) : String(text).slice(0, 300);
    throw new ApiError(res.status, `HTTP ${res.status}: ${msg}`);
  }
  return data;
}

/** Compact JSON for the model: drop empty values, cap long arrays. */
export function compact(value, maxItems = 50) {
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => compact(v, maxItems));
    return value.length > maxItems ? [...items, `… and ${value.length - maxItems} more`] : items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v, maxItems);
    }
    return out;
  }
  return value;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

/**
 * Build an MCP server from a service definition:
 *   { name, title, env: ['WB_TOKEN'], tools: [{ name, description, input: {zod shape}, write?: true, run(args, env) }] }
 * Write tools (change data in the customer's system) require `confirm: true` — the agent has to ask the user first.
 */
export function buildServer(service, env = process.env) {
  const server = new McpServer({ name: `tkbk-${service.name}`, version: '0.1.0' });
  const missing = service.env.filter((k) => !env[k]);
  for (const t of service.tools) {
    const input = t.write ? { ...t.input, confirm: z.boolean().optional().describe('Must be true: the user explicitly confirmed this change') } : t.input;
    server.registerTool(
      t.name,
      {
        title: t.title || t.name,
        description: t.description + (t.write ? ' Changes data: call only after the user confirmed, with confirm=true.' : ''),
        inputSchema: input,
        annotations: { readOnlyHint: !t.write, destructiveHint: Boolean(t.write) },
      },
      async (args) => {
        if (missing.length) return { ...text(`Not configured: set ${missing.join(', ')} in the MCP server environment.`), isError: true };
        if (t.write && args.confirm !== true) {
          return { ...text('This action changes data. Show the user exactly what will change and call again with confirm=true after they agree.'), isError: true };
        }
        try {
          const out = await t.run(args, env);
          return text(typeof out === 'string' ? out : JSON.stringify(compact(out)));
        } catch (e) {
          return { ...text(e instanceof ApiError ? e.message : `Error: ${e.message}`), isError: true };
        }
      },
    );
  }
  return server;
}
