import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('MCP e OAuth proteggono note e scritture', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'brain-mcp-test-'));
  const backupDir = `${dataDir}-backups`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const serverEnv = { ...process.env, PORT: String(port), BRAIN_PUBLIC_URL: base, BRAIN_DATA_DIR: dataDir, BRAIN_BACKUP_DIR: backupDir, BRAIN_PASSWORD: 'test-password', BRAIN_SESSION_SECRET: 's'.repeat(64), BRAIN_API_TOKEN: '' };
  const startServer = () => spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: serverEnv, stdio: 'ignore' });
  let child = startServer();
  const mcp = async (method, params = {}, bearer = '') => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return { status: response.status, data: await response.json() };
  };
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const clientId = 'https://chatgpt.com/oauth/client.json';
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const authorize = async scope => {
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: `${base}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', scope, state: 'test-state' });
    const page = await fetch(`${base}/oauth/authorize?${query}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt\.com/);
    const html = await page.text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(requestId);
    const grant = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: new URLSearchParams({ request_id: requestId, password: 'test-password' }), redirect: 'manual' });
    assert.equal(grant.status, 302);
    const location = new URL(grant.headers.get('location'));
    assert.equal(location.origin, 'https://chatgpt.com');
    assert.equal(location.searchParams.get('iss'), base);
    assert.equal(location.searchParams.get('state'), 'test-state');
    return location.searchParams.get('code');
  };
  const exchange = async code => {
    const response = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, resource: `${base}/mcp`, code, code_verifier: verifier }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/api/session`); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(resource.resource, `${base}/mcp`);
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const initialized = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.data.result.serverInfo.name, 'tommi-brain');
    const listed = await mcp('tools/list');
    assert.equal(listed.status, 200);
    assert.ok(listed.data.result.tools.some(tool => tool.name === 'create_note'));
    assert.deepEqual(listed.data.result.tools.find(tool => tool.name === 'create_note').securitySchemes, [{ type: 'oauth2', scopes: ['brain.write'] }]);
    assert.equal(listed.data.result.tools.find(tool => tool.name === 'create_note').inputSchema.properties.path.pattern, undefined);
    assert.equal(listed.data.result.tools.find(tool => tool.name === 'update_note').inputSchema.properties.path.pattern, undefined);
    assert.equal(listed.data.result.tools.find(tool => tool.name === 'get_profile')._meta['openai/profile'], true);
    assert.ok(listed.data.result.tools.find(tool => tool.name === 'get_profile').outputSchema);
    const unauth = await mcp('tools/call', { name: 'list_items', arguments: { path: '' } });
    assert.equal(unauth.data.result.isError, true);
    assert.ok(unauth.data.result._meta['mcp/www_authenticate']);
    const badClient = new URLSearchParams({ response_type: 'code', client_id: 'attacker', redirect_uri: redirect, resource: `${base}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', scope: 'brain.read' });
    assert.equal((await fetch(`${base}/oauth/authorize?${badClient}`)).status, 400);
    const badScope = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: `${base}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', scope: 'brain.admin', state: 'invalid-scope-state' });
    const badScopeResponse = await fetch(`${base}/oauth/authorize?${badScope}`, { redirect: 'manual' });
    assert.equal(badScopeResponse.status, 302);
    const badScopeRedirect = new URL(badScopeResponse.headers.get('location'));
    assert.equal(badScopeRedirect.searchParams.get('error'), 'invalid_request');
    assert.equal(badScopeRedirect.searchParams.get('iss'), base);
    assert.equal(badScopeRedirect.searchParams.get('state'), 'invalid-scope-state');
    const staleGrant = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: new URLSearchParams({ request_id: 'missing', password: 'test-password' }) });
    assert.equal(staleGrant.status, 400);
    assert.match(staleGrant.headers.get('content-type'), /text\/html/);
    assert.match(await staleGrant.text(), /avvia di nuovo il collegamento da ChatGPT/);

    const restartQuery = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: `${base}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', scope: 'brain.read', state: 'restart-state' });
    const restartPage = await fetch(`${base}/oauth/authorize?${restartQuery}`);
    const restartRequestId = /name="request_id" value="([^"]+)"/.exec(await restartPage.text())?.[1];
    assert.ok(restartRequestId);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    child = startServer();
    let restarted = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/api/session`); restarted = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(restarted);
    const restartGrant = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: new URLSearchParams({ request_id: restartRequestId, password: 'test-password' }), redirect: 'manual' });
    assert.equal(restartGrant.status, 302, 'il modulo OAuth resta valido dopo il riavvio del processo');
    const restartCode = new URL(restartGrant.headers.get('location')).searchParams.get('code');
    assert.equal((await exchange(restartCode)).status, 200);
    const repeatedGrant = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: new URLSearchParams({ request_id: restartRequestId, password: 'test-password' }), redirect: 'manual' });
    assert.equal(repeatedGrant.status, 302, 'un secondo invio del modulo valido non appare come scaduto');
    const repeatedCode = new URL(repeatedGrant.headers.get('location')).searchParams.get('code');
    assert.notEqual(repeatedCode, restartCode);
    assert.equal((await exchange(repeatedCode)).status, 200);

    const invalidCode = await authorize('brain.read');
    const badVerifier = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, resource: `${base}/mcp`, code: invalidCode, code_verifier: 'x'.repeat(64) }) });
    assert.equal(badVerifier.status, 400);
    assert.equal((await exchange(invalidCode)).status, 400, 'un codice OAuth usato con PKCE errato non è riutilizzabile');

    const readCode = await authorize('brain.read');
    const readToken = await exchange(readCode);
    assert.equal(readToken.status, 200);
    const denied = await mcp('tools/call', { name: 'create_note', arguments: { path: 'No.md', content: 'no' } }, readToken.data.access_token);
    assert.equal(denied.data.result.isError, true);
    const listedRead = await mcp('tools/call', { name: 'list_items', arguments: { path: '' } }, readToken.data.access_token);
    assert.deepEqual(listedRead.data.result.structuredContent.items, []);

    const writeCode = await authorize('brain.read brain.write');
    const writeToken = await exchange(writeCode);
    assert.equal(writeToken.status, 200);
    const bearer = writeToken.data.access_token;
    const invalidExtension = await mcp('tools/call', { name: 'create_note', arguments: { path: 'NonMarkdown.exe', content: 'no' } }, bearer);
    assert.equal(invalidExtension.data.result.isError, true);
    const created = await mcp('tools/call', { name: 'create_note', arguments: { path: 'MCP.md', content: '# MCP' } }, bearer);
    assert.equal(created.data.result.structuredContent.path, 'MCP.md');
    const file = await mcp('tools/call', { name: 'read_file', arguments: { path: 'MCP.md' } }, bearer);
    assert.equal(file.data.result.structuredContent.content, '# MCP');
    const updated = await mcp('tools/call', { name: 'update_note', arguments: { path: 'MCP.md', content: '# MCP\n\nAggiornata', modified_at: file.data.result.structuredContent.modified_at } }, bearer);
    assert.equal(updated.data.result.structuredContent.ok, true);
    const deleted = await mcp('tools/call', { name: 'delete_item', arguments: { path: 'MCP.md' } }, bearer);
    assert.ok(deleted.data.result.structuredContent.trashId);
    const restored = await mcp('tools/call', { name: 'restore_item', arguments: { id: deleted.data.result.structuredContent.trashId } }, bearer);
    assert.equal(restored.data.result.structuredContent.path, 'MCP.md');
    const parts = bearer.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    const tampered = parts.join('.');
    assert.equal((await mcp('tools/call', { name: 'list_items', arguments: { path: '' } }, tampered)).data.result.isError, true);
    const refreshed = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, resource: `${base}/mcp`, refresh_token: writeToken.data.refresh_token }) });
    assert.equal(refreshed.status, 200);
    assert.ok((await refreshed.json()).access_token);
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});
