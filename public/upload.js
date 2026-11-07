// Use relative paths supplied by the directory picker, never flatten a directory.
export async function uploadFiles(files, destination, { api, onProgress = () => {} }) {
  const folders = new Set();
  const collect = nodes => nodes.forEach(node => { folders.add(node.path); collect(node.children); });
  collect((await api('/api/tree')).folders);
  const result = { uploaded: 0, skipped: 0, errors: [] };
  const join = (a, b) => a ? `${a}/${b}` : b;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const relative = file.webkitRelativePath || file.name;
    const parts = relative.split('/');
    if (parts.some(part => part.startsWith('.') && part !== '..' && part !== '.')) { result.skipped++; continue; }
    try {
      if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new Error('Percorso non valido');
      if (file.size > 25 * 1024 * 1024) throw new Error('File troppo grande (massimo 25 MB)');
      let directory = destination;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        if (!folders.has(directory)) {
          await api('/api/folders', { method: 'POST', body: JSON.stringify({ path: directory }) });
          folders.add(directory);
        }
      }
      const path = join(destination, relative);
      await api(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      result.uploaded++;
    } catch (error) { result.errors.push(`${relative}: ${error.message}`); }
    onProgress(index + 1, files.length);
  }
  return result;
}
