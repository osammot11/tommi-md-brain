import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
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

test('flusso file e protezioni principali', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'brain-test-'));
  const backupDir = `${dataDir}-backups`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), BRAIN_DATA_DIR: dataDir, BRAIN_BACKUP_DIR: backupDir, BRAIN_PASSWORD: 'test-password', BRAIN_SESSION_SECRET: 'a'.repeat(64), BRAIN_API_TOKEN: 'b'.repeat(64) },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/api/session`); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'il server deve avviarsi');
    const request = async (method, url, body, cookie = '') => {
      const response = await fetch(`${base}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body) });
      return { status: response.status, data: await response.json().catch(() => ({})), response };
    };
    assert.equal((await request('GET', '/api/items')).status, 401);
    assert.equal((await request('POST', '/api/login', { password: 'wrong' })).status, 401);
    const login = await request('POST', '/api/login', { password: 'test-password' });
    assert.equal(login.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('POST', '/api/folders', { path: 'Progetti' }, cookie)).status, 201);
    assert.equal((await request('POST', '/api/folders', { path: 'Progetti/Clienti' }, cookie)).status, 201);
    assert.equal((await request('POST', '/api/folders', { path: 'Progetti/Clienti/Acme' }, cookie)).status, 201);
    const folders = (await request('GET', '/api/tree', undefined, cookie)).data.folders;
    assert.equal(folders[0].children[0].children[0].path, 'Progetti/Clienti/Acme');
    assert.equal((await request('GET', '/api/items?path=Progetti%2FClienti', undefined, cookie)).data.items[0].name, 'Acme');
    assert.equal((await request('DELETE', '/api/items', { path: 'Progetti/Clienti' }, cookie)).status, 200);
    const trashedFolder = (await request('GET', '/api/trash', undefined, cookie)).data.items.find(item => item.path === 'Progetti/Clienti');
    assert.equal((await request('POST', '/api/trash/restore', { id: trashedFolder.id }, cookie)).status, 200);
    assert.equal((await request('GET', '/api/items?path=Progetti%2FClienti', undefined, cookie)).data.items[0].name, 'Acme');
    assert.equal((await request('POST', '/api/files', { path: 'Progetti/Idea.md', content: '# Idea' }, cookie)).status, 201);
    const file = await request('GET', '/api/file?path=Progetti%2FIdea.md', undefined, cookie);
    assert.equal(file.data.content, '# Idea');
    const save = await request('PUT', '/api/file', { path: 'Progetti/Idea.md', content: '# Idea\n\nContenuto', modifiedAt: file.data.modifiedAt }, cookie);
    assert.equal(save.status, 200);
    assert.equal((await request('PUT', '/api/file', { path: 'Progetti/Idea.md', content: 'stale', modifiedAt: file.data.modifiedAt }, cookie)).status, 409);
    assert.equal((await request('GET', '/api/search?q=contenuto', undefined, cookie)).data.items[0].path, 'Progetti/Idea.md');
    assert.equal((await request('POST', '/api/move', { from: 'Progetti/Idea.md', to: 'Idea.md' }, cookie)).status, 200);
    assert.equal((await readFile(join(dataDir, 'Idea.md'), 'utf8')).includes('Contenuto'), true);
    const versions = (await request('GET', '/api/versions?path=Idea.md', undefined, cookie)).data.versions;
    assert.equal(versions.length, 1);
    assert.equal((await request('GET', `/api/version?id=${versions[0].id}`, undefined, cookie)).data.content, '# Idea');
    assert.equal((await request('POST', '/api/versions/restore', { id: versions[0].id }, cookie)).status, 200);
    assert.equal(await readFile(join(dataDir, 'Idea.md'), 'utf8'), '# Idea');
    assert.equal((await request('POST', '/api/files', { path: 'Link.md', content: 'Vedi [[Idea]]' }, cookie)).status, 201);
    assert.equal((await request('GET', '/api/resolve?from=Link.md&target=Idea', undefined, cookie)).data.item.path, 'Idea.md');
    assert.deepEqual((await request('GET', '/api/links?path=Idea.md', undefined, cookie)).data.backlinks, ['Link.md']);
    const template = await request('POST', '/api/templates', { name: 'Mio modello', content: '# {{title}}' }, cookie);
    assert.equal(template.status, 201);
    assert.equal((await request('GET', '/api/templates', undefined, cookie)).data.templates.some(t => t.name === 'Mio modello'), true);
    assert.equal((await request('POST', '/api/upload?path=Allegato.pdf', new Blob(['pdf-bytes']), cookie)).status, 201);
    const raw = await fetch(`${base}/api/raw?path=Allegato.pdf`, { headers: { Cookie: cookie } });
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), 'pdf-bytes');
    const upload = await request('POST', '/api/upload?path=Idea.md', new Blob(['binary']), cookie);
    assert.equal(upload.status, 409);
    assert.equal(await readFile(join(dataDir, 'Idea.md'), 'utf8'), '# Idea');
    assert.equal((await request('GET', '/api/file?path=..%2F.env', undefined, cookie)).status, 400);
    assert.equal((await request('DELETE', '/api/items', { path: 'Idea.md' }, cookie)).status, 200);
    assert.equal((await request('GET', '/api/items', undefined, cookie)).data.items.some(item => item.path === 'Idea.md'), false);
    const trash = (await request('GET', '/api/trash', undefined, cookie)).data.items;
    assert.equal(trash[0].path, 'Idea.md');
    assert.equal((await request('POST', '/api/trash/restore', { id: trash[0].id }, cookie)).status, 200);
    assert.equal(await readFile(join(dataDir, 'Idea.md'), 'utf8'), '# Idea');
    const backup = await request('POST', '/api/backups', {}, cookie);
    assert.equal(backup.status, 201);
    assert.equal((await readdir(join(backupDir, backup.data.id))).includes('Idea.md'), true);
    assert.equal((await request('GET', '/api/items', undefined, '')).status, 401);
    const bearer = await fetch(`${base}/api/items`, { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } });
    assert.equal(bearer.status, 200);
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});
