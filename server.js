import { createServer } from 'node:http';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { randomBytes, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, resolve, sep, basename } from 'node:path';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.BRAIN_DATA_DIR || join(here, 'data'));
const systemDir = join(root, '.brain');
const trashDir = join(systemDir, 'trash');
const versionsDir = join(systemDir, 'versions');
const templatesDir = join(systemDir, 'templates');
const backupRoot = resolve(process.env.BRAIN_BACKUP_DIR || `${root}-backups`);
const port = Number(process.env.PORT || 3000);
const password = process.env.BRAIN_PASSWORD || '';
const secret = process.env.BRAIN_SESSION_SECRET || '';
const apiToken = process.env.BRAIN_API_TOKEN || '';
const secureCookie = process.env.BRAIN_SECURE_COOKIE === '1';
const maxText = 2 * 1024 * 1024;
const maxUpload = 25 * 1024 * 1024;
const textExtensions = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.css', '.js', '.ts', '.xml', '.svg']);
const mime = { '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const loginAttempts = new Map();
const builtinTemplates = [
  { id: 'blank', name: 'Nota semplice', builtin: true, content: '# {{title}}\n\n' },
  { id: 'project', name: 'Progetto', builtin: true, content: '---\ntags: [progetto]\nstato: idea\ndata: {{date}}\n---\n\n# {{title}}\n\n## Obiettivo\n\n## Prossimi passi\n\n- [ ] \n' },
  { id: 'meeting', name: 'Riunione', builtin: true, content: '---\ntags: [riunione]\nstato: aperto\ndata: {{date}}\n---\n\n# {{title}}\n\n## Partecipanti\n\n## Appunti\n\n## Azioni\n\n- [ ] \n' },
  { id: 'idea', name: 'Idea', builtin: true, content: '---\ntags: [idea]\nstato: nuova\ndata: {{date}}\n---\n\n# {{title}}\n\n## Descrizione\n\n## Collegamenti\n\n' }
];
const backupRetention = Math.max(1, Math.min(30, Number(process.env.BRAIN_BACKUP_RETENTION || 7)));
let backupRunning = false;
let lastBackup = null;
let backupPromise = null;

function error(status, message) { const e = new Error(message); e.status = status; return e; }
function cleanPath(input = '') {
  if (typeof input !== 'string' || input.includes('\\') || input.includes('\0')) throw error(400, 'Percorso non valido');
  const parts = input.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || p.startsWith('.') || p.length > 255)) throw error(400, 'Percorso non valido');
  return parts.join('/');
}
function localPath(relative) {
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(root + sep)) throw error(400, 'Percorso non valido');
  return full;
}
async function assertSafe(relative, allowMissingLast = false) {
  const clean = cleanPath(relative);
  const parts = clean ? clean.split('/') : [];
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw error(400, 'I link simbolici non sono supportati');
      if (i < parts.length - 1 && !stat.isDirectory()) throw error(400, 'La cartella padre non esiste');
    } catch (e) {
      if (e.code === 'ENOENT' && allowMissingLast && i === parts.length - 1) break;
      if (e.code === 'ENOENT') throw error(404, 'File o cartella non trovato');
      throw e;
    }
  }
  return localPath(clean);
}
async function parseJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > maxText * 2) throw error(413, 'Richiesta troppo grande');
  }
  try { return JSON.parse(data || '{}'); } catch { throw error(400, 'JSON non valido'); }
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function equal(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function sign(value) { return createHmac('sha256', secret).update(value).digest('hex'); }
function session(req) {
  const match = /(?:^|;\s*)brain_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!match) return false;
  const [expiry, signature] = match[1].split('.');
  return /^\d+$/.test(expiry) && Number(expiry) > Date.now() && signature && equal(sign(expiry), signature);
}
function authorized(req) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  return session(req) || (!!apiToken && !!bearer && equal(apiToken, bearer[1]));
}
function verifyPassword(candidate) {
  const salt = 'tommi-md-brain-login-v1';
  const a = scryptSync(String(candidate || ''), salt, 64);
  const b = scryptSync(password, salt, 64);
  return timingSafeEqual(a, b);
}
function checkOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (new URL(origin).host !== host) throw error(403, 'Origine non consentita');
}
async function entry(relative, dirent) {
  const path = relative ? `${relative}/${dirent.name}` : dirent.name;
  const stat = await fs.stat(localPath(path));
  return { name: dirent.name, path, type: dirent.isDirectory() ? 'folder' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString(), editable: dirent.isFile() && textExtensions.has(extname(dirent.name).toLowerCase()) };
}
async function list(relative) {
  const full = await assertSafe(relative);
  if (!(await fs.stat(full)).isDirectory()) throw error(400, 'Non è una cartella');
  const dirents = (await fs.readdir(full, { withFileTypes: true })).filter(d => !d.name.startsWith('.') && (d.isDirectory() || d.isFile()));
  const entries = await Promise.all(dirents.map(d => entry(cleanPath(relative), d)));
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1));
}
async function tree(relative = '', depth = 0) {
  if (depth > 20) return [];
  const entries = await list(relative);
  return Promise.all(entries.filter(e => e.type === 'folder').map(async e => ({ name: e.name, path: e.path, children: await tree(e.path, depth + 1) })));
}
async function search(query) {
  const results = [];
  const needle = query.toLocaleLowerCase('it');
  async function walk(relative, depth) {
    if (depth > 20 || results.length >= 100) return;
    for (const e of await list(relative)) {
      if (e.name.toLocaleLowerCase('it').includes(needle)) results.push(e);
      if (e.type === 'folder') await walk(e.path, depth + 1);
      else if (e.editable && e.size < maxText && results.length < 100 && !e.name.toLocaleLowerCase('it').includes(needle)) {
        const content = await fs.readFile(localPath(e.path), 'utf8');
        if (content.toLocaleLowerCase('it').includes(needle)) results.push(e);
      }
    }
  }
  await walk('', 0);
  return results.slice(0, 100);
}
function id() { return `${Date.now()}-${randomBytes(6).toString('hex')}`; }
async function readJson(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }
async function writeJson(path, value) { await fs.writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' }); }
async function versionRecords() {
  const names = (await fs.readdir(versionsDir)).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(async name => readJson(join(versionsDir, name))));
}
async function snapshotVersion(relative, full) {
  const stat = await fs.stat(full);
  if (!stat.isFile() || stat.size > maxText) return;
  const versionId = id();
  await fs.copyFile(full, join(versionsDir, `${versionId}.bin`));
  await writeJson(join(versionsDir, `${versionId}.json`), { id: versionId, path: relative, createdAt: new Date().toISOString(), size: stat.size });
  const matching = (await versionRecords()).filter(v => v.path === relative).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of matching.slice(50)) {
    await fs.rm(join(versionsDir, `${old.id}.bin`), { force: true });
    await fs.rm(join(versionsDir, `${old.id}.json`), { force: true });
  }
}
async function moveVersionPaths(from, to) {
  for (const record of await versionRecords()) {
    if (record.path !== from && !record.path.startsWith(from + '/')) continue;
    record.path = to + record.path.slice(from.length);
    await fs.writeFile(join(versionsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }
}
async function trashRecords() {
  const ids = await fs.readdir(trashDir);
  const records = [];
  for (const itemId of ids) {
    try { records.push(await readJson(join(trashDir, itemId, 'meta.json'))); } catch { /* ignore incomplete entry */ }
  }
  return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}
async function makeBackup(force = false) {
  if (backupPromise) { await backupPromise; if (!force) return lastBackup; }
  const run = async () => {
  await fs.mkdir(backupRoot, { recursive: true });
  const existing = (await fs.readdir(backupRoot)).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  if (!force && existing.some(name => name.startsWith(today))) return existing[0] || null;
  backupRunning = true;
  const backupId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const temp = join(backupRoot, `.partial-${backupId}`);
  try {
    await fs.cp(root, temp, { recursive: true, errorOnExist: true, force: false });
    await fs.rename(temp, join(backupRoot, backupId));
    lastBackup = backupId;
    const after = (await fs.readdir(backupRoot)).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().reverse();
    for (const old of after.slice(backupRetention)) await fs.rm(join(backupRoot, old), { recursive: true, force: true });
    return backupId;
  } finally { backupRunning = false; await fs.rm(temp, { recursive: true, force: true }); }
  };
  backupPromise = run();
  try { return await backupPromise; } finally { backupPromise = null; }
}
async function allFiles(relative = '', output = [], depth = 0) {
  if (depth > 20) return output;
  for (const item of await list(relative)) {
    if (item.type === 'folder') await allFiles(item.path, output, depth + 1);
    else output.push(item);
  }
  return output;
}
function matchingFile(from, target, files) {
  const base = String(target || '').split('|')[0].split('#')[0].trim();
  if (!base || /^(?:[a-z]+:|\/\/)/i.test(base)) return null;
  let decoded;
  try { decoded = decodeURIComponent(base); } catch { decoded = base; }
  const relative = posix.normalize(posix.join(posix.dirname('/' + from), decoded)).slice(1);
  const candidates = [relative, `${relative}.md`, `${relative}.markdown`];
  const exact = files.find(f => candidates.some(c => f.path.toLocaleLowerCase('it') === c.toLocaleLowerCase('it')));
  if (exact) return exact;
  const key = posix.basename(decoded).replace(/\.(md|markdown)$/i, '').toLocaleLowerCase('it');
  const matches = files.filter(f => f.type === 'file' && f.name.replace(/\.(md|markdown)$/i, '').toLocaleLowerCase('it') === key);
  return matches.length === 1 ? matches[0] : null;
}
function noteTargets(content) {
  const targets = [];
  for (const match of content.matchAll(/!?(?:\[\[([^\]]+)\]\]|\[[^\]]*\]\(([^)]+)\))/g)) targets.push(match[1] || match[2]);
  return targets;
}
async function customTemplates() {
  const names = (await fs.readdir(templatesDir)).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(name => readJson(join(templatesDir, name))));
}
async function api(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) throw error(429, 'Troppi tentativi. Riprova tra qualche minuto.');
    const body = await parseJson(req);
    if (!verifyPassword(body.password)) {
      attempt.count++;
      attempt.until = attempt.count >= 5 ? Date.now() + 5 * 60_000 : 0;
      loginAttempts.set(ip, attempt);
      throw error(401, 'Password errata');
    }
    loginAttempts.delete(ip);
    const expiry = String(Date.now() + 7 * 24 * 60 * 60_000);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `brain_session=${expiry}.${sign(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}` });
  }
  if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: authorized(req) });
  if (!authorized(req)) throw error(401, 'Accesso richiesto');
  if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': `brain_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}` });
  if (url.pathname === '/api/trash' && req.method === 'GET') return send(res, 200, { items: await trashRecords() });
  if (url.pathname === '/api/trash/restore' && req.method === 'POST') {
    const body = await parseJson(req);
    if (typeof body.id !== 'string' || !/^\d+-[a-f0-9]{12}$/.test(body.id)) throw error(400, 'Elemento non valido');
    const container = join(trashDir, body.id);
    const record = await readJson(join(container, 'meta.json'));
    const target = await assertSafe(record.path, true);
    try { await fs.lstat(target); throw error(409, 'Esiste già un elemento con questo nome'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(join(container, 'item'), target);
    await fs.rm(container, { recursive: true, force: true });
    return send(res, 200, { path: record.path });
  }
  if (url.pathname === '/api/versions' && req.method === 'GET') {
    const relative = cleanPath(url.searchParams.get('path') || '');
    if (!relative) throw error(400, 'File richiesto');
    return send(res, 200, { versions: (await versionRecords()).filter(v => v.path === relative).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if (url.pathname === '/api/version' && req.method === 'GET') {
    const versionId = url.searchParams.get('id') || '';
    if (!/^\d+-[a-f0-9]{12}$/.test(versionId)) throw error(400, 'Versione non valida');
    const record = await readJson(join(versionsDir, `${versionId}.json`));
    return send(res, 200, { ...record, content: await fs.readFile(join(versionsDir, `${versionId}.bin`), 'utf8') });
  }
  if (url.pathname === '/api/versions/restore' && req.method === 'POST') {
    const body = await parseJson(req);
    if (typeof body.id !== 'string' || !/^\d+-[a-f0-9]{12}$/.test(body.id)) throw error(400, 'Versione non valida');
    const record = await readJson(join(versionsDir, `${body.id}.json`));
    const full = await assertSafe(record.path);
    await snapshotVersion(record.path, full);
    const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    try { await fs.copyFile(join(versionsDir, `${body.id}.bin`), temp); await fs.rename(temp, full); }
    finally { await fs.rm(temp, { force: true }); }
    return send(res, 200, { path: record.path, modifiedAt: (await fs.stat(full)).mtime.toISOString() });
  }
  if (url.pathname === '/api/backups' && req.method === 'GET') {
    await fs.mkdir(backupRoot, { recursive: true });
    const backups = (await fs.readdir(backupRoot)).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().reverse();
    return send(res, 200, { backups, directory: backupRoot, retention: backupRetention });
  }
  if (url.pathname === '/api/backups' && req.method === 'POST') return send(res, 201, { id: await makeBackup(true) });
  if (url.pathname === '/api/templates' && req.method === 'GET') return send(res, 200, { templates: [...builtinTemplates, ...await customTemplates()] });
  if (url.pathname === '/api/templates' && req.method === 'POST') {
    const body = await parseJson(req);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || typeof body.content !== 'string' || Buffer.byteLength(body.content) > maxText) throw error(400, 'Modello non valido');
    const template = { id: id(), name: body.name.trim(), content: body.content, builtin: false };
    await writeJson(join(templatesDir, `${template.id}.json`), template);
    return send(res, 201, { template });
  }
  if (url.pathname === '/api/templates' && req.method === 'DELETE') {
    const templateId = url.searchParams.get('id') || '';
    if (!/^\d+-[a-f0-9]{12}$/.test(templateId)) throw error(400, 'Modello non valido');
    await fs.rm(join(templatesDir, `${templateId}.json`));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/resolve' && req.method === 'GET') {
    const from = cleanPath(url.searchParams.get('from') || '');
    const target = url.searchParams.get('target') || '';
    const found = matchingFile(from, target, await allFiles());
    if (!found) throw error(404, 'Collegamento non trovato o ambiguo');
    return send(res, 200, { item: found });
  }
  if (url.pathname === '/api/links' && req.method === 'GET') {
    const relative = cleanPath(url.searchParams.get('path') || '');
    if (!relative) throw error(400, 'Nota richiesta');
    const files = await allFiles();
    const notes = files.filter(f => /\.(md|markdown)$/i.test(f.name) && f.size <= maxText);
    const outbound = new Set(), backlinks = new Set();
    for (const note of notes) {
      const content = await fs.readFile(localPath(note.path), 'utf8');
      for (const target of noteTargets(content)) {
        const matched = matchingFile(note.path, target, notes);
        if (!matched) continue;
        if (note.path === relative && matched.path !== relative) outbound.add(matched.path);
        if (matched.path === relative && note.path !== relative) backlinks.add(note.path);
      }
    }
    return send(res, 200, { outbound: [...outbound].sort(), backlinks: [...backlinks].sort() });
  }
  if (url.pathname === '/api/tree' && req.method === 'GET') return send(res, 200, { folders: await tree() });
  if (url.pathname === '/api/items' && req.method === 'GET') return send(res, 200, { items: await list(url.searchParams.get('path') || '') });
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    return send(res, 200, { items: q.length >= 2 ? await search(q) : [] });
  }
  if (url.pathname === '/api/file' && req.method === 'GET') {
    const relative = cleanPath(url.searchParams.get('path') || '');
    if (!relative) throw error(400, 'Seleziona un file');
    const full = await assertSafe(relative);
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw error(400, 'Non è un file');
    if (url.searchParams.has('download')) {
      res.writeHead(200, { 'Content-Type': mime[extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(full))}`, 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff' });
      return pipeline(createReadStream(full), res);
    }
    if (!textExtensions.has(extname(full).toLowerCase())) return send(res, 200, { path: relative, editable: false, size: stat.size });
    if (stat.size > maxText) throw error(413, 'File troppo grande per l’editor');
    return send(res, 200, { path: relative, editable: true, content: await fs.readFile(full, 'utf8'), modifiedAt: stat.mtime.toISOString() });
  }
  if (url.pathname === '/api/raw' && req.method === 'GET') {
    const relative = cleanPath(url.searchParams.get('path') || '');
    const full = await assertSafe(relative);
    const stat = await fs.stat(full);
    const type = mime[extname(full).toLowerCase()];
    if (!stat.isFile() || !['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw error(400, 'Anteprima non disponibile');
    res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': 'inline', 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return pipeline(createReadStream(full), res);
  }
  if (url.pathname === '/api/file' && req.method === 'PUT') {
    const body = await parseJson(req);
    const relative = cleanPath(body.path);
    if (!relative || !textExtensions.has(extname(relative).toLowerCase()) || typeof body.content !== 'string') throw error(400, 'File non modificabile');
    if (Buffer.byteLength(body.content) > maxText) throw error(413, 'File troppo grande per l’editor');
    const full = await assertSafe(relative);
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw error(400, 'Non è un file');
    if (body.modifiedAt && stat.mtime.toISOString() !== body.modifiedAt) throw error(409, 'Il file è cambiato sul disco. Ricaricalo prima di salvare.');
    await snapshotVersion(relative, full);
    const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    try { await fs.writeFile(temp, body.content, { flag: 'wx' }); await fs.rename(temp, full); }
    finally { await fs.rm(temp, { force: true }); }
    return send(res, 200, { ok: true, modifiedAt: (await fs.stat(full)).mtime.toISOString() });
  }
  if (url.pathname === '/api/folders' && req.method === 'POST') {
    const body = await parseJson(req);
    const relative = cleanPath(body.path);
    if (!relative) throw error(400, 'Nome cartella richiesto');
    const full = await assertSafe(relative, true);
    await fs.mkdir(full);
    return send(res, 201, { path: relative });
  }
  if (url.pathname === '/api/files' && req.method === 'POST') {
    const body = await parseJson(req);
    const relative = cleanPath(body.path);
    if (!relative || !textExtensions.has(extname(relative).toLowerCase())) throw error(400, 'Nome file non valido');
    const full = await assertSafe(relative, true);
    const content = typeof body.content === 'string' ? body.content : '';
    if (Buffer.byteLength(content) > maxText) throw error(413, 'File troppo grande per l’editor');
    await fs.writeFile(full, content, { flag: 'wx' });
    const stat = await fs.stat(full);
    return send(res, 201, { path: relative, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const relative = cleanPath(url.searchParams.get('path') || '');
    if (!relative) throw error(400, 'Nome file richiesto');
    const full = await assertSafe(relative, true);
    if (Number(req.headers['content-length'] || 0) > maxUpload) throw error(413, 'File troppo grande (massimo 25 MB)');
    let bytes = 0;
    const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    const output = createWriteStream(temp, { flags: 'wx' });
    try {
      req.on('data', chunk => { bytes += chunk.length; if (bytes > maxUpload) req.destroy(error(413, 'File troppo grande')); });
      await pipeline(req, output);
      await fs.link(temp, full);
    } finally { await fs.rm(temp, { force: true }); }
    return send(res, 201, { path: relative });
  }
  if (url.pathname === '/api/move' && req.method === 'POST') {
    const body = await parseJson(req);
    const from = cleanPath(body.from), to = cleanPath(body.to);
    if (!from || !to || from === to || to.startsWith(from + '/')) throw error(400, 'Spostamento non valido');
    const source = await assertSafe(from), target = await assertSafe(to, true);
    try { await fs.lstat(target); throw error(409, 'Esiste già un elemento con questo nome'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(source, target);
    await moveVersionPaths(from, to);
    return send(res, 200, { path: to });
  }
  if (url.pathname === '/api/items' && req.method === 'DELETE') {
    const body = await parseJson(req);
    const relative = cleanPath(body.path);
    if (!relative) throw error(400, 'Impossibile eliminare la cartella principale');
    const full = await assertSafe(relative);
    const itemId = id();
    const container = join(trashDir, itemId);
    const stat = await fs.stat(full);
    await fs.mkdir(container);
    try {
      await writeJson(join(container, 'meta.json'), { id: itemId, path: relative, name: basename(relative), type: stat.isDirectory() ? 'folder' : 'file', deletedAt: new Date().toISOString() });
      await fs.rename(full, join(container, 'item'));
    } catch (e) { await fs.rm(container, { recursive: true, force: true }); throw e; }
    return send(res, 200, { ok: true, trashId: itemId });
  }
  throw error(404, 'Operazione non trovata');
}
async function staticFile(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) throw error(405, 'Metodo non consentito');
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const asset = assets[url.pathname];
  if (!asset) throw error(404, 'Pagina non trovata');
  const body = await fs.readFile(join(here, 'public', asset[0]));
  res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : body);
}

if (!password || password === 'change-this-long-password' || secret.length < 32 || secret.startsWith('replace-with-') || (apiToken && apiToken.length < 32)) {
  console.error('Imposta BRAIN_PASSWORD e BRAIN_SESSION_SECRET (almeno 32 caratteri); l’eventuale BRAIN_API_TOKEN richiede almeno 32 caratteri.');
  process.exit(1);
}
if (backupRoot === root || backupRoot.startsWith(root + sep)) {
  console.error('BRAIN_BACKUP_DIR deve essere fuori da BRAIN_DATA_DIR.');
  process.exit(1);
}
await fs.mkdir(root, { recursive: true });
await Promise.all([fs.mkdir(trashDir, { recursive: true }), fs.mkdir(versionsDir, { recursive: true }), fs.mkdir(templatesDir, { recursive: true })]);
makeBackup().catch(e => console.error('Backup automatico non riuscito:', e));
setInterval(() => makeBackup().catch(e => console.error('Backup automatico non riuscito:', e)), 60 * 60 * 1000).unref();
createServer(async (req, res) => {
  try {
    checkOrigin(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || (e.code === 'EEXIST' ? 409 : e.code === 'ENOENT' ? 404 : 500), { error: e.status || e.code === 'EEXIST' || e.code === 'ENOENT' ? e.message : 'Errore interno del server' });
    else res.destroy();
    if (!e.status && e.code !== 'EEXIST') console.error(e);
  }
}).listen(port, '127.0.0.1', () => console.log(`Brain pronto su http://127.0.0.1:${port}`));
