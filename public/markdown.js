export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function frontmatter(source) {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(source);
  return match ? { raw: match[1], body: source.slice(match[0].length), full: match[0] } : { raw: '', body: source, full: '' };
}

export function parseProperties(source) {
  const { raw } = frontmatter(source);
  const properties = {};
  for (const line of raw.split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    else value = value.replace(/^['"]|['"]$/g, '');
    properties[match[1]] = value;
  }
  return properties;
}

export function updateProperties(source, values) {
  const parsed = frontmatter(source);
  const lines = parsed.raw ? parsed.raw.split('\n') : [];
  const kept = lines.filter(line => !/^(tags|stato|data):\s*/.test(line) && line.trim());
  const tags = String(values.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  if (tags.length) kept.push(`tags: [${tags.map(tag => JSON.stringify(tag)).join(', ')}]`);
  if (values.stato) kept.push(`stato: ${JSON.stringify(String(values.stato))}`);
  if (values.data) kept.push(`data: ${JSON.stringify(String(values.data))}`);
  if (!kept.length) return parsed.body;
  return `---\n${kept.join('\n')}\n---\n\n${parsed.body.replace(/^\n*/, '')}`;
}

export function fillTemplate(template, title, date) {
  return template.replaceAll('{{title}}', title).replaceAll('{{date}}', date);
}

function inline(input) {
  const tokens = [];
  const hold = html => `\uE000${tokens.push(html) - 1}\uE001`;
  let source = input.replace(/!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/g, (whole, wikiImage, wikiLink, imageAlt, imageTarget, linkText, linkTarget, code) => {
    if (code !== undefined) return hold(`<code>${escapeHtml(code)}</code>`);
    if (wikiImage !== undefined || imageTarget !== undefined) {
      const target = wikiImage ?? imageTarget;
      const alt = imageAlt ?? target;
      return hold(`<img data-brain-asset="${escapeHtml(target)}" alt="${escapeHtml(alt)}" loading="lazy">`);
    }
    const target = wikiLink ?? linkTarget;
    const label = wikiLink ? wikiLink.split('|')[1] || wikiLink.split('|')[0] : linkText;
    if (/^https?:\/\//i.test(target)) return hold(`<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    if (/^[a-z]+:/i.test(target)) return escapeHtml(whole);
    return hold(`<a href="#" data-brain-link="${escapeHtml(target)}">${escapeHtml(label)}</a>`);
  });
  source = escapeHtml(source)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return source.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)]);
}

function tableCells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()); }
function isTableSeparator(line) { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }

export function renderMarkdown(source) {
  const lines = frontmatter(String(source || '').replace(/\r\n?/g, '\n')).body.split('\n');
  let html = '', block = '', code = false, codeLines = [], language = '';
  const close = () => { if (block) { html += `</${block}>`; block = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w-]*)/.exec(line);
    if (fence) {
      close();
      if (code) { html += `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`; codeLines = []; language = ''; }
      else language = fence[1];
      code = !code; continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { close(); continue; }
    if (i + 1 < lines.length && line.includes('|') && isTableSeparator(lines[i + 1])) {
      close(); const headers = tableCells(line); html += '<div class="table-wrap"><table><thead><tr>' + headers.map(cell => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) html += '<tr>' + tableCells(lines[i]).map(cell => `<td>${inline(cell)}</td>`).join('') + '</tr>';
      html += '</tbody></table></div>'; i--; continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { close(); const level = heading[1].length; html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { close(); html += '<hr>'; continue; }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (task || bullet || numbered) {
      const tag = numbered ? 'ol' : 'ul';
      if (block !== tag) { close(); html += `<${tag}${task ? ' class="tasks"' : ''}>`; block = tag; }
      html += task ? `<li class="task"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${inline(task[2])}</li>` : `<li>${inline((bullet || numbered)[1])}</li>`;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { if (block !== 'blockquote') { close(); html += '<blockquote>'; block = 'blockquote'; } html += `<p>${inline(quote[1])}</p>`; continue; }
    if (block !== 'p') { close(); html += '<p>'; block = 'p'; } else html += '<br>';
    html += inline(line);
  }
  close(); if (code) html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
  return html || '<p class="empty-markdown">Questa nota è vuota. Premi “Modifica” per iniziare a scrivere.</p>';
}
