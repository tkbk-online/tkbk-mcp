// The real entry point: `tkbk-mcp <service>` serves the service over stdio, an unknown name prints the usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const EXIT_USAGE = 2;

/** service → [its tools, a call that needs credentials, the variable the answer must name]. */
const NEW_SERVICES = {
  avito: [['avito_chats', 'avito_messages', 'avito_send_message', 'avito_items'], ['avito_chats', {}], /AVITO_CLIENT_ID, AVITO_CLIENT_SECRET/],
  'yandex-direct': [['direct_campaigns', 'direct_stats'], ['direct_campaigns', {}], /DIRECT_TOKEN/],
  'yandex-metrika': [['metrika_counters', 'metrika_summary', 'metrika_sources'], ['metrika_counters', {}], /METRIKA_TOKEN/],
  'yandex-webmaster': [['webmaster_hosts', 'webmaster_summary', 'webmaster_queries'], ['webmaster_hosts', {}], /WEBMASTER_TOKEN/],
  dadata: [['dadata_party', 'dadata_address', 'dadata_bank'], ['dadata_bank', { query: '044525225' }], /DADATA_API_KEY/],
};

for (const [name, [tools, [tool, args], missing]] of Object.entries(NEW_SERVICES)) {
  test(`tkbk-mcp ${name}: lists its tools over stdio and asks for its credentials`, async () => {
    const client = new Client({ name: 'cli-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, name] }));
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [...tools].sort());
      const r = await client.callTool({ name: tool, arguments: args });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, missing);
    } finally {
      await client.close();
    }
  });
}

test('tkbk-mcp with an unknown service prints the usage with every service and exits with 2', () => {
  const r = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, EXIT_USAGE);
  for (const name of ['wb', 'ozon', 'yandex-market', 'bitrix24', 'amocrm', ...Object.keys(NEW_SERVICES), 'direct', 'metrika', 'webmaster']) {
    assert.ok(r.stderr.includes(name), name);
  }
});
