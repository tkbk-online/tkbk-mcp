#!/usr/bin/env node
// tkbk-mcp <service>  — one MCP server over stdio (Claude Code, Cursor, Claude Desktop);
// tkbk-mcp http       — the hosted Streamable HTTP server (mcp.tkbk.online), settings from the environment;
// tkbk-mcp key-id     — key id (sha256 hex) of a TKBK key for the subscription allow-list: argument or stdin.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './core.mjs';
import { SERVICES } from './index.mjs';

const EXIT_USAGE = 2;
const [command, arg] = process.argv.slice(2);

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (command === 'http') {
  const { startHttpServer } = await import('./http.mjs');
  startHttpServer();
} else if (command === 'key-id') {
  const { isKeyFormat, keyIdOf } = await import('./hosted/auth.mjs');
  const key = (arg ?? (process.stdin.isTTY ? '' : await readStdin())).trim();
  if (!isKeyFormat(key)) {
    console.error('usage: tkbk-mcp key-id cr_…   (or: echo cr_… | tkbk-mcp key-id)');
    process.exit(EXIT_USAGE);
  }
  console.log(keyIdOf(key));
} else if (command && Object.hasOwn(SERVICES, command)) {
  await buildServer(SERVICES[command]).connect(new StdioServerTransport());
} else {
  console.error(`usage: tkbk-mcp <${Object.keys(SERVICES).join('|')}> | http | key-id`);
  process.exit(EXIT_USAGE);
}
