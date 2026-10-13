import { renderMarkdown, parseProperties, updateProperties, fillTemplate } from './markdown.js';

const $ = id => document.getElementById(id);
const state = { folder: '', file: null, content: '', saved: '', modifiedAt: '', folders: [], search: '', editing: false, view: 'files', noticeTimer: null, selectedVersion: null };
const els = Object.fromEntries(['login','app','login-form','login-error','password','items','empty','search-empty','folder-tree','context-menu','breadcrumbs','page-title','page-subtitle','browser-view','trash-view','trash-items','trash-empty','file-view','file-title','file-location','file-meta','preview','editor','binary-preview','editor-controls','preview-tab','edit-tab','save-button','dirty-indicator','search','upload-input','dialog','dialog-form','dialog-title','dialog-description','dialog-fields','dialog-submit','dialog-eyebrow','notice','drop-overlay','sidebar','properties-panel','properties-list','format-toolbar','links-panel','outbound-links','backlinks','history-dialog','history-list','history-preview','history-restore','backup-dialog','backup-details'].map(id => [id,$(id)]));
const collapsedFolders = new Set();

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') showLogin();
    throw new Error(payload.error || `Errore ${res.status}`);
  }
  return payload;
}
function json(method, path, body) { return api(path, { method, body: JSON.stringify(body) }); }
function showLogin() { els.login.classList.remove('hidden'); els.app.classList.add('hidden'); els.password.focus(); }
function showApp() { els.login.classList.add('hidden'); els.app.classList.remove('hidden'); }
function notice(message, isError = false) {
  els.notice.textContent = message; els.notice.style.background = isError ? '#a84d4d' : '#263f52'; els.notice.classList.remove('hidden');
  clearTimeout(state.noticeTimer); state.noticeTimer = setTimeout(() => els.notice.classList.add('hidden'), 4200);
}
function handle(error) { notice(error.message || String(error), true); }
function pathName(path) { return path.split('/').pop() || 'Tutti i file'; }
function parent(path) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
function join(folder, name) { return folder ? `${folder}/${name}` : name; }
function formatSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function formatDate(iso) { return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
function iconFor(entry) { if (entry.type === 'folder') return ['⌑', 'folder']; if (/\.(md|markdown)$/i.test(entry.name)) return ['MD', 'md']; return [entry.name.split('.').pop().slice(0, 3).toUpperCase() || 'FILE', '']; }
function dirty() { return state.file && state.content !== state.saved; }
function updateDirty() { els['save-button'].disabled = !dirty(); els['dirty-indicator'].textContent = dirty() ? 'Modifiche non salvate' : 'Tutte le modifiche salvate'; }
function confirmLeave() { return !dirty() || confirm('Ci sono modifiche non salvate. Vuoi uscire senza salvarle?'); }

function renderTree() {
  els['folder-tree'].replaceChildren();
  const add = (nodes, depth) => nodes.forEach(node => {
    const row = document.createElement('div'); row.className = 'tree-row' + (state.folder === node.path ? ' active' : ''); row.style.paddingLeft = `${8 + depth * 13}px`;
    const toggle = document.createElement(node.children.length ? 'button' : 'span'); toggle.className = 'tree-toggle';
    if (node.children.length) {
      toggle.type = 'button'; toggle.textContent = collapsedFolders.has(node.path) ? '▸' : '▾';
      toggle.setAttribute('aria-label', `${collapsedFolders.has(node.path) ? 'Apri' : 'Chiudi'} ${node.name}`);
      toggle.setAttribute('aria-expanded', String(!collapsedFolders.has(node.path)));
      toggle.onclick = () => { if (collapsedFolders.has(node.path)) collapsedFolders.delete(node.path); else collapsedFolders.add(node.path); renderTree(); };
    } else toggle.setAttribute('aria-hidden', 'true');
    const folder = document.createElement('button'); folder.type = 'button'; folder.className = 'tree-folder'; folder.onclick = () => navigate(node.path).catch(handle);
    const glyph = document.createElement('span'); glyph.className = 'folder-glyph'; glyph.textContent = '▰';
    const label = document.createElement('span'); label.textContent = node.name;
    folder.append(glyph, label); row.append(toggle, folder);
    row.oncontextmenu = e => { e.preventDefault(); showContextMenu({ path: node.path, name: node.name, type: 'folder' }, e.clientX, e.clientY); };
    row.ondragover = e => { if (e.dataTransfer.types.includes('text/plain')) e.preventDefault(); };
    row.ondrop = e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); if (from) moveEntry(from, node.path).catch(handle); };
    els['folder-tree'].append(row); if (!collapsedFolders.has(node.path)) add(node.children, depth + 1);
  });
  add(state.folders, 0);
  $('home-button').classList.toggle('active', !state.folder);
}
async function refreshTree() { state.folders = (await api('/api/tree')).folders; renderTree(); }
function collapseAllFolders() {
  const collect = nodes => nodes.forEach(node => { if (node.children.length) collapsedFolders.add(node.path); collect(node.children); });
  collect(state.folders); renderTree();
}
function renderBreadcrumbs() {
  els.breadcrumbs.replaceChildren();
  const parts = state.folder ? state.folder.split('/') : [];
  const all = [{ name: 'Tutti i file', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
  all.forEach((piece, i) => {
    if (i) { const sep = document.createElement('span'); sep.textContent = '/'; els.breadcrumbs.append(sep); }
    const button = document.createElement('button'); button.textContent = piece.name; button.onclick = () => navigate(piece.path); els.breadcrumbs.append(button);
  });
}
function showBrowser() { state.view = 'files'; els['browser-view'].classList.remove('hidden'); els['file-view'].classList.add('hidden'); els['trash-view'].classList.add('hidden'); $('trash-button').classList.remove('active'); }
function showFile() { state.view = 'file'; els['browser-view'].classList.add('hidden'); els['file-view'].classList.remove('hidden'); els['trash-view'].classList.add('hidden'); $('trash-button').classList.remove('active'); }
function showTrash() { state.view = 'trash'; els['browser-view'].classList.add('hidden'); els['file-view'].classList.add('hidden'); els['trash-view'].classList.remove('hidden'); $('trash-button').classList.add('active'); }
async function navigate(folder = '') {
  if (!confirmLeave()) return;
  state.file = null; state.folder = folder; state.search = ''; els.search.value = '';
  for (let path = parent(folder); path; path = parent(path)) collapsedFolders.delete(path);
  showBrowser(); renderBreadcrumbs();
  els['page-title'].textContent = pathName(folder);
  els['page-subtitle'].textContent = folder ? `Cartella · ${folder}` : 'Un posto per ogni idea.';
  $('subfolder-button').classList.toggle('hidden', !folder);
  await refreshTree(); await loadItems(); els.sidebar.classList.remove('open');
}
async function loadItems() {
  const searching = !!state.search;
  const data = await api(searching ? `/api/search?q=${encodeURIComponent(state.search)}` : `/api/items?path=${encodeURIComponent(state.folder)}`);
  renderItems(data.items, searching);
}
function renderItems(items, searching = false) {
  els.items.replaceChildren();
  els.empty.classList.toggle('hidden', searching || items.length > 0);
  els['search-empty'].classList.toggle('hidden', !searching || items.length > 0);
  if (searching) { els['page-title'].textContent = 'Risultati di ricerca'; els['page-subtitle'].textContent = `${items.length} risultati per “${state.search}”`; }
  for (const entry of items) {
    const row = document.createElement('div'); row.className = 'item-row'; row.tabIndex = 0; row.role = 'button'; row.draggable = true;
    const name = document.createElement('div'); name.className = 'item-name';
    const [symbol, iconClass] = iconFor(entry); const icon = document.createElement('span'); icon.className = `file-icon ${iconClass}`; icon.textContent = symbol;
    const title = document.createElement('span'); title.textContent = entry.name; name.append(icon, title);
    const date = document.createElement('span'); date.className = 'item-date'; date.textContent = formatDate(entry.modifiedAt);
    const size = document.createElement('span'); size.className = 'item-size'; size.textContent = entry.type === 'folder' ? '—' : formatSize(entry.size);
    const more = document.createElement('button'); more.className = 'item-more'; more.type = 'button'; more.title = 'Azioni'; more.setAttribute('aria-label', `Azioni per ${entry.name}`); more.textContent = '···';
    more.onclick = e => { e.stopPropagation(); const rect = more.getBoundingClientRect(); showContextMenu(entry, rect.left, rect.bottom + 4); };
    row.append(name, date, size, more); row.onclick = () => entry.type === 'folder' ? navigate(entry.path) : openFile(entry);
    row.oncontextmenu = e => { e.preventDefault(); showContextMenu(entry, e.clientX, e.clientY); };
    row.onkeydown = e => { if (e.target === row && e.key === 'Enter') row.click(); };
    row.ondragstart = e => e.dataTransfer.setData('text/plain', entry.path);
    if (entry.type === 'folder') {
      row.ondragover = e => e.preventDefault();
      row.ondrop = e => { e.preventDefault(); e.stopPropagation(); const from = e.dataTransfer.getData('text/plain'); if (from) moveEntry(from, entry.path).catch(handle); };
    }
    els.items.append(row);
  }
}
async function openFile(entry) {
  if (!confirmLeave()) return;
  const file = await api(`/api/file?path=${encodeURIComponent(entry.path)}`);
  state.file = entry.path; state.folder = parent(entry.path); state.saved = file.content || ''; state.content = state.saved; state.modifiedAt = file.modifiedAt || ''; state.editing = false;
  for (let path = state.folder; path; path = parent(path)) collapsedFolders.delete(path);
  renderTree(); renderBreadcrumbs();
  els['file-title'].textContent = entry.name; els['file-location'].textContent = state.folder ? state.folder.toUpperCase() : 'ARCHIVIO';
  els['file-meta'].textContent = `${formatSize(entry.size)} · ${formatDate(entry.modifiedAt)}`;
  els.editor.value = state.content; updatePreview();
  els['editor-controls'].classList.toggle('hidden', !file.editable);
  els['binary-preview'].classList.toggle('hidden', file.editable);
  const isMarkdown = /\.(md|markdown)$/i.test(entry.name);
  $('history-file').classList.toggle('hidden', !file.editable);
  $('template-file').classList.toggle('hidden', !isMarkdown);
  els['properties-panel'].classList.toggle('hidden', !isMarkdown);
  els['links-panel'].classList.toggle('hidden', !isMarkdown);
  renderProperties();
  if (isMarkdown) loadLinks(entry.path).catch(handle);
  if (!file.editable) {
    els['binary-preview'].replaceChildren();
    const ext = entry.name.split('.').pop().toLowerCase();
    if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
      const img = document.createElement('img'); img.src = `/api/raw?path=${encodeURIComponent(entry.path)}`; img.alt = entry.name; els['binary-preview'].append(img);
    } else if (ext === 'pdf') {
      const frame = document.createElement('iframe'); frame.src = `/api/raw?path=${encodeURIComponent(entry.path)}`; frame.title = entry.name; els['binary-preview'].append(frame);
    } else { const p = document.createElement('p'); p.textContent = 'Questo file non ha un’anteprima. Puoi scaricarlo e aprirlo sul tuo dispositivo.'; els['binary-preview'].append(p); }
  }
  selectTab(false); updateDirty(); showFile(); els.sidebar.classList.remove('open');
}
function selectTab(edit) {
  state.editing = edit; els.preview.classList.toggle('hidden', edit || els['editor-controls'].classList.contains('hidden'));
  els.editor.classList.toggle('hidden', !edit); els['preview-tab'].classList.toggle('selected', !edit); els['edit-tab'].classList.toggle('selected', edit);
  els['format-toolbar'].classList.toggle('hidden', !edit || !/\.(md|markdown)$/i.test(state.file || ''));
  if (!edit) updatePreview(); else els.editor.focus();
}
async function save() {
  if (!dirty()) return;
  const result = await json('PUT', '/api/file', { path: state.file, content: state.content, modifiedAt: state.modifiedAt });
  state.saved = state.content; state.modifiedAt = result.modifiedAt; updateDirty(); renderProperties(); if (/\.(md|markdown)$/i.test(state.file)) loadLinks(state.file).catch(handle); notice('Nota salvata');
}
function updatePreview() {
  els.preview.innerHTML = renderMarkdown(state.content);
  for (const img of els.preview.querySelectorAll('[data-brain-asset]')) {
    api(`/api/resolve?from=${encodeURIComponent(state.file || '')}&target=${encodeURIComponent(img.dataset.brainAsset)}`)
      .then(({ item }) => { if (/\.(png|jpe?g|gif|webp)$/i.test(item.name)) img.src = `/api/raw?path=${encodeURIComponent(item.path)}`; else img.replaceWith(document.createTextNode(img.alt)); })
      .catch(() => img.replaceWith(document.createTextNode(`Immagine non trovata: ${img.alt}`)));
  }
}
function renderProperties() {
  els['properties-list'].replaceChildren();
  if (!/\.(md|markdown)$/i.test(state.file || '')) return;
  const props = parseProperties(state.content);
  for (const key of ['tags', 'stato', 'data']) {
    const value = props[key]; if (!value || (Array.isArray(value) && !value.length)) continue;
    const chip = document.createElement('span'); chip.className = 'property-chip'; chip.textContent = `${key}: ${Array.isArray(value) ? value.join(', ') : value}`; els['properties-list'].append(chip);
  }
}
async function loadLinks(path) {
  const data = await api(`/api/links?path=${encodeURIComponent(path)}`);
  if (state.file !== path) return;
  for (const [id, paths] of [['outbound-links', data.outbound], ['backlinks', data.backlinks]]) {
    const container = $(id); container.replaceChildren();
    if (!paths.length) { const p = document.createElement('p'); p.textContent = 'Nessuna nota'; container.append(p); continue; }
    paths.forEach(linkPath => { const button = document.createElement('button'); button.className = 'note-link'; button.textContent = pathName(linkPath); button.title = linkPath; button.onclick = async () => { try { const data = await api(`/api/items?path=${encodeURIComponent(parent(linkPath))}`); const entry = data.items.find(e => e.path === linkPath); if (entry) await openFile(entry); } catch (e) { handle(e); } }; container.append(button); });
  }
}
els.preview.addEventListener('click', async e => {
  const link = e.target.closest('[data-brain-link]'); if (!link) return;
  e.preventDefault();
  try { const { item } = await api(`/api/resolve?from=${encodeURIComponent(state.file)}&target=${encodeURIComponent(link.dataset.brainLink)}`); await openFile(item); }
  catch (err) { handle(err); }
});

function dialog({ eyebrow = 'AZIONE', title, description = '', fields = [], submit = 'Conferma', danger = false, onSubmit }) {
  els['dialog-eyebrow'].textContent = eyebrow; els['dialog-title'].textContent = title; els['dialog-description'].textContent = description;
  els['dialog-fields'].replaceChildren(); els['dialog-submit'].textContent = submit; els['dialog-submit'].className = `button ${danger ? 'danger' : 'primary'}`;
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = field.label; label.htmlFor = `field-${field.name}`;
    const input = document.createElement(field.options ? 'select' : 'input'); input.id = `field-${field.name}`; input.name = field.name; input.required = field.required !== false;
    if (field.options) field.options.forEach(o => { const option = document.createElement('option'); option.value = o.value; option.textContent = o.label; input.append(option); });
    else { input.type = field.type || 'text'; input.value = field.value || ''; input.placeholder = field.placeholder || ''; }
    els['dialog-fields'].append(label, input);
  }
  els['dialog-form'].onsubmit = async e => { e.preventDefault(); try { const values = Object.fromEntries(new FormData(els['dialog-form'])); await onSubmit(values); els.dialog.close(); } catch (err) { handle(err); } };
  els.dialog.showModal(); els['dialog-fields'].querySelector('input,select')?.focus();
}
function validateName(name) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('.') || trimmed.includes('/') || trimmed.includes('\\')) throw new Error('Inserisci un nome valido senza / o \\.');
  return trimmed;
}
function allFolders(nodes, output = [{ value: '', label: 'Tutti i file (radice)' }], depth = 0) { nodes.forEach(n => { output.push({ value: n.path, label: `${'　'.repeat(depth)}${n.name}` }); allFolders(n.children, output, depth + 1); }); return output; }
function newFolder(destination = state.folder) { dialog({ eyebrow: 'ORGANIZZA', title: 'Nuova cartella', description: `Verrà creata in “${pathName(destination)}”.`, fields: [{ name: 'name', label: 'Nome della cartella', placeholder: 'Es. Progetti' }], submit: 'Crea cartella', onSubmit: async ({ name }) => { await json('POST', '/api/folders', { path: join(destination, validateName(name)) }); collapsedFolders.delete(destination); await refreshTree(); if (state.view === 'files') await loadItems(); notice('Cartella creata'); } }); }
async function newNote(destination = state.folder) { try { const { templates } = await api('/api/templates'); dialog({ eyebrow: 'SCRIVI', title: 'Nuova nota', description: `Verrà creata in “${pathName(destination)}”.`, fields: [{ name: 'name', label: 'Nome della nota', placeholder: 'Es. Una nuova idea' }, { name: 'template', label: 'Modello', options: templates.map(t => ({ value: t.id, label: t.name })) }], submit: 'Crea nota', onSubmit: async ({ name, template }) => { const title = validateName(name); const filename = /\.md$/i.test(title) ? title : `${title}.md`; const path = join(destination, filename); const selected = templates.find(t => t.id === template) || templates[0]; const content = fillTemplate(selected.content, title.replace(/\.md$/i, ''), new Intl.DateTimeFormat('sv-SE').format(new Date())); const created = await json('POST', '/api/files', { path, content }); if (state.view === 'files') await loadItems(); await openFile({ name: filename, path, size: created.size, modifiedAt: created.modifiedAt }); selectTab(true); notice('Nota creata'); } }); } catch (e) { handle(e); } }
function newMenu() { dialog({ eyebrow: 'CREA', title: 'Aggiungi al tuo archivio', description: 'Scegli cosa vuoi creare nella cartella corrente.', submit: 'Crea', fields: [{ name: 'type', label: 'Tipo', options: [{ value: 'note', label: 'Nota Markdown' }, { value: 'folder', label: 'Cartella' }] }], onSubmit: async ({ type }) => { setTimeout(() => type === 'folder' ? newFolder() : newNote(), 0); } }); }
function rebasePath(path, from, to) { return path === from ? to : path?.startsWith(from + '/') ? to + path.slice(from.length) : path; }
function relocateView(from, to) {
  const previousFile = state.file;
  const nextFolder = rebasePath(state.folder, from, to);
  const nextFile = rebasePath(state.file, from, to);
  state.folder = nextFolder; state.file = nextFile;
  if (state.view === 'file' && nextFile !== previousFile) state.folder = parent(nextFile);
  for (const path of [...collapsedFolders]) if (path === from || path.startsWith(from + '/')) { collapsedFolders.delete(path); collapsedFolders.add(rebasePath(path, from, to)); }
  renderBreadcrumbs();
  if (state.view === 'files' && !state.search) { els['page-title'].textContent = pathName(state.folder); els['page-subtitle'].textContent = state.folder ? `Cartella · ${state.folder}` : 'Un posto per ogni idea.'; }
  if (state.view === 'file' && state.file) { els['file-title'].textContent = pathName(state.file); els['file-location'].textContent = state.folder ? state.folder.toUpperCase() : 'ARCHIVIO'; }
}
async function renameEntry(entry) {
  dialog({ eyebrow: 'ORGANIZZA', title: 'Rinomina', fields: [{ name: 'name', label: 'Nuovo nome', value: entry.name }], submit: 'Rinomina', onSubmit: async ({ name }) => { const to = join(parent(entry.path), validateName(name)); if (to === entry.path) return; await json('POST', '/api/move', { from: entry.path, to }); relocateView(entry.path, to); await refreshTree(); if (state.view === 'files') await loadItems(); notice('Nome aggiornato'); } });
}
async function moveEntry(from, destination) {
  if (from === destination || destination.startsWith(from + '/')) throw new Error('Non puoi spostare una cartella dentro sé stessa.');
  const to = join(destination, pathName(from));
  if (from === to) return;
  await json('POST', '/api/move', { from, to }); relocateView(from, to); await refreshTree(); if (state.view === 'files') await loadItems(); notice('Elemento spostato');
}
function moveDialog(entry) { dialog({ eyebrow: 'ORGANIZZA', title: 'Sposta elemento', description: `Sposta “${entry.name}” in un’altra cartella.`, fields: [{ name: 'destination', label: 'Destinazione', required: false, options: allFolders(state.folders).filter(o => o.value !== entry.path && !o.value.startsWith(entry.path + '/')) }], submit: 'Sposta', onSubmit: async ({ destination }) => { await moveEntry(entry.path, destination); } }); }
function deleteEntry(entry) { if (state.file && (state.file === entry.path || state.file.startsWith(entry.path + '/')) && !confirmLeave()) return; dialog({ eyebrow: 'RECUPERO', title: 'Sposta nel cestino', description: `Spostare “${entry.name}”${entry.type === 'folder' ? ' e il suo contenuto' : ''} nel cestino? Potrai ripristinarlo in seguito.`, submit: 'Sposta nel cestino', onSubmit: async () => { await json('DELETE', '/api/items', { path: entry.path }); if (state.file && (state.file === entry.path || state.file.startsWith(entry.path + '/'))) { state.file = null; showBrowser(); } if (state.folder === entry.path || state.folder.startsWith(entry.path + '/')) state.folder = parent(entry.path); renderBreadcrumbs(); els['page-title'].textContent = pathName(state.folder); els['page-subtitle'].textContent = state.folder ? `Cartella · ${state.folder}` : 'Un posto per ogni idea.'; await refreshTree(); if (state.view === 'files') await loadItems(); notice('Elemento spostato nel cestino'); } }); }
function closeContextMenu() { els['context-menu'].classList.add('hidden'); els['context-menu'].replaceChildren(); }
function showContextMenu(entry, x, y) {
  closeContextMenu();
  const options = [
    { label: 'Apri', action: () => entry.type === 'folder' ? navigate(entry.path) : openFile(entry) },
    ...(entry.type === 'folder' ? [
      { label: 'Nuova nota qui', action: () => newNote(entry.path) },
      { label: 'Nuova sottocartella', action: () => newFolder(entry.path) }
    ] : [{ label: 'Scarica', action: () => download(entry.path) }]),
    { label: 'Rinomina', action: () => renameEntry(entry) },
    { label: 'Sposta', action: () => moveDialog(entry) },
    { label: 'Sposta nel cestino', danger: true, action: () => deleteEntry(entry) }
  ];
  for (const option of options) {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = option.label;
    if (option.danger) button.classList.add('danger-text');
    button.onclick = () => { closeContextMenu(); Promise.resolve(option.action()).catch(handle); };
    els['context-menu'].append(button);
  }
  els['context-menu'].classList.remove('hidden');
  const bounds = els['context-menu'].getBoundingClientRect();
  els['context-menu'].style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  els['context-menu'].style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  els['context-menu'].querySelector('button')?.focus();
}
function download(path) { const a = document.createElement('a'); a.href = `/api/file?path=${encodeURIComponent(path)}&download=1`; a.download = pathName(path); document.body.append(a); a.click(); a.remove(); }
async function upload(files) {
  for (const file of files) {
    try {
      const name = validateName(file.name);
      const path = join(state.folder, name);
      await api(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      notice(`Caricato: ${name}`);
    } catch (err) { handle(err); }
  }
  await loadItems();
}
async function showTrashPage() {
  if (!confirmLeave()) return;
  state.file = null; showTrash(); els.sidebar.classList.remove('open');
  const { items } = await api('/api/trash');
  els['trash-items'].replaceChildren(); els['trash-empty'].classList.toggle('hidden', items.length > 0);
  for (const entry of items) {
    const row = document.createElement('div'); row.className = 'item-row';
    const name = document.createElement('div'); name.className = 'item-name'; name.textContent = entry.path;
    const date = document.createElement('span'); date.textContent = formatDate(entry.deletedAt);
    const type = document.createElement('span'); type.textContent = entry.type === 'folder' ? 'Cartella' : 'File';
    const restore = document.createElement('button'); restore.className = 'restore-button'; restore.textContent = 'Ripristina';
    restore.onclick = async () => { try { await json('POST', '/api/trash/restore', { id: entry.id }); await refreshTree(); await showTrashPage(); notice('Elemento ripristinato'); } catch (e) { handle(e); } };
    row.append(name, date, type, restore); els['trash-items'].append(row);
  }
}
async function openBackups() {
  try { const { backups, directory, retention } = await api('/api/backups');
    els['backup-details'].replaceChildren();
    const location = document.createElement('p'); location.textContent = `Cartella: ${directory}`; els['backup-details'].append(location);
    const count = document.createElement('p'); count.textContent = `${backups.length} ${backups.length === 1 ? 'copia disponibile' : 'copie disponibili'} · vengono conservate le ultime ${retention}.`; els['backup-details'].append(count);
    for (const name of backups) { const item = document.createElement('div'); const iso = name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z$/, 'T$1:$2:$3.$4Z'); item.className = 'backup-item'; item.textContent = Number.isNaN(Date.parse(iso)) ? name : new Date(iso).toLocaleString('it-IT'); els['backup-details'].append(item); }
    els['backup-dialog'].showModal();
  } catch (e) { handle(e); }
}
async function openHistory() {
  try { const { versions } = await api(`/api/versions?path=${encodeURIComponent(state.file)}`);
    state.selectedVersion = null; els['history-restore'].disabled = true; els['history-list'].replaceChildren(); els['history-preview'].textContent = versions.length ? 'Seleziona una versione per vederla.' : 'Non ci sono ancora versioni precedenti.';
    for (const version of versions) {
      const button = document.createElement('button'); button.className = 'history-item'; button.textContent = `${formatDate(version.createdAt)} · ${new Date(version.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · ${formatSize(version.size)}`;
      button.onclick = async () => { try { const record = await api(`/api/version?id=${encodeURIComponent(version.id)}`); state.selectedVersion = version.id; els['history-preview'].textContent = record.content; els['history-restore'].disabled = false; for (const item of els['history-list'].children) item.classList.toggle('active', item === button); } catch (e) { handle(e); } };
      els['history-list'].append(button);
    }
    els['history-dialog'].showModal();
  } catch (e) { handle(e); }
}
function editProperties() {
  const props = parseProperties(state.content);
  dialog({ eyebrow: 'ORGANIZZA', title: 'Proprietà della nota', description: 'Le proprietà vengono salvate nel frontmatter YAML del file.', fields: [
    { name: 'tags', label: 'Tag (separati da virgola)', value: Array.isArray(props.tags) ? props.tags.join(', ') : props.tags || '', required: false },
    { name: 'stato', label: 'Stato', value: props.stato || '', required: false },
    { name: 'data', label: 'Data', value: props.data || '', type: 'date', required: false }
  ], submit: 'Applica', onSubmit: async values => { state.content = updateProperties(state.content, values); els.editor.value = state.content; updateDirty(); renderProperties(); updatePreview(); notice('Proprietà aggiornate: salva la nota per confermare'); } });
}
function insertText(text, selectionOffset = text.length) {
  const editor = els.editor; const start = editor.selectionStart, end = editor.selectionEnd;
  editor.setRangeText(text, start, end, 'end'); editor.focus(); editor.setSelectionRange(start + selectionOffset, start + selectionOffset);
  state.content = editor.value; updateDirty();
}
function formatSelection(kind) {
  const editor = els.editor; const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (kind === 'bold') insertText(`**${selected || 'testo'}**`, selected ? selected.length + 4 : 2);
  else if (kind === 'italic') insertText(`*${selected || 'testo'}*`, selected ? selected.length + 2 : 1);
  else if (kind === 'heading') insertText(`# ${selected || 'Titolo'}`);
  else if (kind === 'list') insertText(`- ${selected || 'Voce'}`);
  else if (kind === 'task') insertText(`- [ ] ${selected || 'Attività'}`);
  else if (kind === 'link') insertText(`[[${selected || 'Nome nota'}]]`, selected ? selected.length + 4 : 2);
}
async function attachFiles(files) {
  if (!state.file || !/\.(md|markdown)$/i.test(state.file)) return;
  const folder = join(parent(state.file), 'Allegati');
  try { await json('POST', '/api/folders', { path: folder }); } catch (e) { if (!/exist|exists|EEXIST/i.test(e.message)) throw e; }
  for (const file of files) {
    const name = validateName(file.name);
    let path = join(folder, name);
    try { await api(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }); }
    catch (e) { if (!/exist|exists|EEXIST/i.test(e.message)) throw e; path = join(folder, `${Date.now()}-${name}`); await api(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }); }
    const relative = `Allegati/${pathName(path)}`;
    const markup = /\.(png|jpe?g|gif|webp)$/i.test(name) ? `![${name}](${relative})` : `[${name}](${relative})`;
    insertText(`${els.editor.value && !els.editor.value.endsWith('\n') ? '\n' : ''}${markup}\n`);
  }
  await refreshTree(); notice('Allegato inserito nella nota: salva per confermare');
}

els['login-form'].onsubmit = async e => { e.preventDefault(); try { await json('POST', '/api/login', { password: els.password.value }); els.password.value = ''; els['login-error'].textContent = ''; showApp(); await navigate(''); } catch (err) { els['login-error'].textContent = err.message; } };
$('logout-button').onclick = async () => { if (!confirmLeave()) return; await api('/api/logout', { method: 'POST' }); state.file = null; showLogin(); };
$('home-button').onclick = () => navigate(''); $('sidebar-new-folder').onclick = () => newFolder(); $('collapse-folders').onclick = collapseAllFolders; $('new-button').onclick = newMenu; $('empty-new').onclick = () => newNote();
$('subfolder-button').onclick = () => newFolder();
$('trash-button').onclick = () => showTrashPage().catch(handle); $('backups-button').onclick = openBackups;
$('backup-close').onclick = () => els['backup-dialog'].close(); $('backup-now').onclick = async () => { try { $('backup-now').disabled = true; await json('POST', '/api/backups', {}); els['backup-dialog'].close(); await openBackups(); notice('Backup creato'); } catch (e) { handle(e); } finally { $('backup-now').disabled = false; } };
$('history-close').onclick = () => els['history-dialog'].close(); $('history-file').onclick = openHistory;
els['history-restore'].onclick = async () => { if (!state.selectedVersion || !confirmLeave()) return; try { const path = state.file; await json('POST', '/api/versions/restore', { id: state.selectedVersion }); els['history-dialog'].close(); state.saved = state.content; const items = (await api(`/api/items?path=${encodeURIComponent(parent(path))}`)).items; await openFile(items.find(item => item.path === path)); notice('Versione ripristinata'); } catch (e) { handle(e); } };
$('edit-properties').onclick = editProperties;
$('template-file').onclick = () => dialog({ eyebrow: 'MODELLI', title: 'Salva come modello', description: 'Il contenuto della nota sarà disponibile quando crei nuove note. Puoi usare {{title}} e {{date}} come segnaposto.', fields: [{ name: 'name', label: 'Nome del modello', value: pathName(state.file).replace(/\.md$/i, '') }], submit: 'Salva modello', onSubmit: async ({ name }) => { await json('POST', '/api/templates', { name: validateName(name), content: state.content }); notice('Modello salvato'); } });
$('upload-button').onclick = () => els['upload-input'].click(); els['upload-input'].onchange = () => { upload([...els['upload-input'].files]); els['upload-input'].value = ''; };
$('back-button').onclick = () => navigate(state.folder); $('preview-tab').onclick = () => selectTab(false); $('edit-tab').onclick = () => selectTab(true);
els.editor.oninput = () => { state.content = els.editor.value; updateDirty(); }; $('save-button').onclick = () => save().catch(handle);
els['format-toolbar'].onclick = e => { const button = e.target.closest('[data-format]'); if (button) formatSelection(button.dataset.format); };
$('attach-button').onclick = () => $('attachment-input').click(); $('attachment-input').onchange = () => { attachFiles([...$('attachment-input').files]).catch(handle); $('attachment-input').value = ''; };
els.editor.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); };
els.editor.ondrop = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); dragDepth = 0; els['drop-overlay'].classList.add('hidden'); attachFiles([...e.dataTransfer.files]).catch(handle); } };
$('rename-file').onclick = () => renameEntry({ path: state.file, name: pathName(state.file), type: 'file' });
$('move-file').onclick = () => moveDialog({ path: state.file, name: pathName(state.file), type: 'file' });
$('download-file').onclick = () => download(state.file); $('delete-file').onclick = () => deleteEntry({ path: state.file, name: pathName(state.file), type: 'file' });
let searchTimer; els.search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(async () => { const query = els.search.value.trim(); if (query.length === 1) return; if (state.file && !confirmLeave()) { els.search.value = state.search; return; } state.file = null; state.search = query; showBrowser(); if (!state.search) { els['page-title'].textContent = pathName(state.folder); els['page-subtitle'].textContent = state.folder ? `Cartella · ${state.folder}` : 'Un posto per ogni idea.'; } try { await loadItems(); } catch (e) { handle(e); } }, 250); };
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); els.search.focus(); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save().catch(handle); } if ((e.metaKey || e.ctrlKey) && state.editing && document.activeElement === els.editor && ['b', 'i'].includes(e.key.toLowerCase())) { e.preventDefault(); formatSelection(e.key.toLowerCase() === 'b' ? 'bold' : 'italic'); } });
document.addEventListener('pointerdown', e => { if (!els['context-menu'].contains(e.target)) closeContextMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeContextMenu(); });
document.addEventListener('scroll', closeContextMenu, true);
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
$('dialog-close').onclick = () => els.dialog.close(); $('dialog-cancel').onclick = () => els.dialog.close();
$('menu-button').onclick = () => els.sidebar.classList.add('open'); $('sidebar-close').onclick = () => els.sidebar.classList.remove('open');
let dragDepth = 0; document.ondragenter = e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; els['drop-overlay'].classList.remove('hidden'); } }; document.ondragleave = e => { if ([...e.dataTransfer.types].includes('Files') && --dragDepth <= 0) { dragDepth = 0; els['drop-overlay'].classList.add('hidden'); } }; document.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); }; document.ondrop = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth = 0; els['drop-overlay'].classList.add('hidden'); upload([...e.dataTransfer.files]); } };

api('/api/session').then(({ authenticated }) => authenticated ? (showApp(), navigate('')) : showLogin()).catch(handle);
