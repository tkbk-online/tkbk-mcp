#!/usr/bin/env node
// tkbk-mcp <service> — run one MCP server over stdio (Claude Code, Cursor, Claude Desktop).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './core.mjs';
import { SERVICES } from './index.mjs';

const name = process.argv[2];
const service = SERVICES[name];
if (!service) {
  console.error(`usage: tkbk-mcp <${Object.keys(SERVICES).join('|')}>`);
  process.exit(2);
}
await buildServer(service).connect(new StdioServerTransport());
