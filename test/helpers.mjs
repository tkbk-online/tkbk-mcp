// Test helpers: a fetch mock for the marketplace APIs (the real fetch stays available for local HTTP) and an MCP client
// connected to a service in memory.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, SERVICES } from '../src/index.mjs';

export const realFetch = globalThis.fetch;

/**
 * Replace globalThis.fetch: every call is recorded; the newest route whose regexp matches the URL answers.
 * route(match, body, status = 200, headers = {}) — body may be a function (url, init, n) => body | {status, body, headers}
 * with n — how many times this route answered before.
 * @returns {{calls: Array<{url: string, init: RequestInit}>, route: Function, last: () => {url: string, init: RequestInit, body: any}}}
 */
export function installFetchMock() {
  const calls = [];
  const routes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes.find((x) => x.match.test(url));
    if (!r) return json({ message: 'not found' }, 404);
    const n = r.count++;
    const out = typeof r.body === 'function' ? r.body(url, init, n) : r.body; // may throw: a network error
    if (out && typeof out === 'object' && 'status' in out && 'body' in out) return json(out.body, out.status, out.headers);
    return json(out, r.status, r.headers);
  };
  const route = (match, body, status = 200, headers = {}) => routes.unshift({ match, body, status, headers, count: 0 });
  const last = () => {
    const c = calls.at(-1);
    return { ...c, body: c.init.body ? JSON.parse(c.init.body) : undefined };
  };
  return { calls, route, last };
}

export function json(body, status = 200, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** MCP client connected in memory to one service with the given env. */
export async function connect(name, env, options) {
  const server = buildServer(SERVICES[name], env, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export const textOf = (r) => r.content[0].text;

/** Call a tool and parse its JSON answer (throws with the text when the tool failed). */
export async function callJson(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return JSON.parse(textOf(r));
}
