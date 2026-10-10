import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, parseProperties, updateProperties, fillTemplate } from '../public/markdown.js';

test('Markdown: tabelle, checklist, immagini e collegamenti sicuri', () => {
  const html = renderMarkdown('---\ntags: [idea]\n---\n\n# Nota\n\n- [x] Fatto\n\n| Nome | Stato |\n| --- | --- |\n| Idea | Aperta |\n\n![foto](Allegati/foto.png)\n\n[[Altra nota]]\n\n<script>alert(1)</script>');
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /data-brain-asset="Allegati\/foto.png"/);
  assert.match(html, /data-brain-link="Altra nota"/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /tags: \[idea\]/);
});

test('Proprietà e modelli conservano il corpo della nota', () => {
  const original = '---\nautore: Tommi\n---\n\n# Corpo';
  const updated = updateProperties(original, { tags: 'progetto, lavoro', stato: 'attivo', data: '2026-10-10' });
  assert.deepEqual(parseProperties(updated).tags, ['progetto', 'lavoro']);
  assert.equal(parseProperties(updated).autore, 'Tommi');
  assert.match(updated, /# Corpo/);
  assert.equal(fillTemplate('# {{title}} · {{date}}', 'Idea', '2026-10-10'), '# Idea · 2026-10-10');
});
