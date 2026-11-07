import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFiles } from '../public/upload.js';

function file(path, content = 'contenuto') {
  return Object.assign(new Blob([content]), { name: path.split('/').pop(), webkitRelativePath: path });
}

test('importazione cartella conserva struttura, contenuti e file preesistenti', async () => {
  const directories = new Set(['Archivio', 'Archivio/Progetto']);
  const stored = new Map([['Archivio/Progetto/Esistente.md', 'originale']]);
  const created = [];
  const api = async (url, options) => {
    if (url === '/api/tree') return { folders: [{ path: 'Archivio', children: [{ path: 'Archivio/Progetto', children: [] }] }] };
    if (url === '/api/folders') {
      const { path } = JSON.parse(options.body);
      assert.ok(directories.has(path.slice(0, path.lastIndexOf('/'))));
      assert.ok(!directories.has(path)); directories.add(path); created.push(path); return {};
    }
    const path = new URL(url, 'http://localhost').searchParams.get('path');
    assert.ok(directories.has(path.slice(0, path.lastIndexOf('/'))));
    if (stored.has(path)) throw new Error('File già esistente');
    stored.set(path, await options.body.text()); return {};
  };
  const result = await uploadFiles([
    file('Progetto/Esistente.md', 'sovrascritto'),
    file('Progetto/Note/Idea.md', '# Idea'),
    file('Progetto/Note/Allegati/dati.bin', 'binary'),
    file('Progetto/.DS_Store'),
    file('Progetto/../fuori.md')
  ], 'Archivio', { api });
  assert.deepEqual(created, ['Archivio/Progetto/Note', 'Archivio/Progetto/Note/Allegati']);
  assert.equal(stored.get('Archivio/Progetto/Esistente.md'), 'originale');
  assert.equal(stored.get('Archivio/Progetto/Note/Idea.md'), '# Idea');
  assert.equal(stored.get('Archivio/Progetto/Note/Allegati/dati.bin'), 'binary');
  assert.equal(result.uploaded, 2); assert.equal(result.skipped, 1); assert.equal(result.errors.length, 2);
});

test('caricamento file singoli alla radice e limite di dimensione', async () => {
  const paths = [];
  const result = await uploadFiles([
    Object.assign(new Blob(['nota']), { name: 'Nota.md' }),
    { name: 'Grande.pdf', size: 26 * 1024 * 1024 }
  ], '', { api: async (url) => {
    if (url === '/api/tree') return { folders: [] };
    paths.push(new URL(url, 'http://localhost').searchParams.get('path')); return {};
  } });
  assert.deepEqual(paths, ['Nota.md']); assert.equal(result.uploaded, 1); assert.equal(result.errors.length, 1);
});
