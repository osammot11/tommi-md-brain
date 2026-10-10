import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const SCOPES = new Set(['brain.read', 'brain.write']);
const AUTH_REQUEST_MS = 30 * 60_000;
const AUTH_CODE_MS = 5 * 60_000;
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const randomId = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function readBody(req, max = 16_384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Richiesta troppo grande'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}

function oauthError(res, status, code, description) {
  json(res, status, { error: code, error_description: description });
}

export function createMcpHandler({ port, password, secret, apiToken, publicUrl = 'https://brain.produceavalue.com' }) {
  const issuer = publicUrl.replace(/\/$/, '');
  const resource = `${issuer}/mcp`;
  const signingKey = createHmac('sha256', secret).update('tommi-brain-mcp-oauth-v1').digest();
  const codes = new Map();
  const loginAttempts = new Map();
  const profileId = `brain-${createHash('sha256').update(issuer).digest('hex').slice(0, 24)}`;

  function token(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = `${header}.${body}`;
    const signature = createHmac('sha256', signingKey).update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
  }

  function verifySignedPayload(value) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const expected = createHmac('sha256', signingKey).update(`${parts[0]}.${parts[1]}`).digest();
    let actual;
    try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || payload.iss !== issuer || payload.aud !== resource || payload.client_id !== CHATGPT_CLIENT_ID || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) || !Number.isInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) + 60 || typeof payload.scope !== 'string') return null;
      if (payload.scope.split(' ').some(scope => !SCOPES.has(scope))) return null;
      return payload;
    } catch { return null; }
  }

  function verifyToken(value, expectedType) {
    const payload = verifySignedPayload(value);
    return payload?.typ === expectedType && payload.sub === profileId ? payload : null;
  }

  function authorizationRequest(state, challenge, scope) {
    const now = Math.floor(Date.now() / 1000);
    return token({ typ: 'oauth_request', iss: issuer, aud: resource, client_id: CHATGPT_CLIENT_ID,
      state, challenge, scope, iat: now, exp: now + AUTH_REQUEST_MS / 1000, jti: randomId() });
  }

  function verifyAuthorizationRequest(value) {
    const payload = verifySignedPayload(value);
    if (payload?.typ !== 'oauth_request' || typeof payload.state !== 'string' || !payload.state || payload.state.length > 1024 ||
      typeof payload.challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.challenge) ||
      !payload.scope.split(' ').every(scope => SCOPES.has(scope))) return null;
    return payload;
  }

  function issueTokens(scope) {
    const now = Math.floor(Date.now() / 1000);
    const common = { iss: issuer, aud: resource, sub: profileId, client_id: CHATGPT_CLIENT_ID, scope, iat: now };
    return {
      access_token: token({ ...common, typ: 'access', exp: now + ACCESS_TOKEN_SECONDS, jti: randomId() }),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: token({ ...common, typ: 'refresh', exp: now + REFRESH_TOKEN_SECONDS, jti: randomId() }),
      scope
    };
  }

  function authorizationError(res, params, code, description) {
    if (params.get('client_id') !== CHATGPT_CLIENT_ID || params.get('redirect_uri') !== CHATGPT_REDIRECT) {
      return oauthError(res, 400, code, description);
    }
    const redirect = new URL(CHATGPT_REDIRECT);
    redirect.searchParams.set('error', code);
    redirect.searchParams.set('error_description', description);
    redirect.searchParams.set('iss', issuer);
    const state = params.get('state');
    if (state && state.length <= 1024) redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  function challenge(scope) {
    const value = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", error="invalid_token", error_description="Accedi a Brain per usare questo strumento"`;
    return {
      isError: true,
      content: [{ type: 'text', text: `Autenticazione Brain richiesta per ${scope}.` }],
      _meta: { 'mcp/www_authenticate': [value] }
    };
  }

  function allowed(req, scope) {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    const payload = match ? verifyToken(match[1], 'access') : null;
    return !!payload && payload.scope.split(' ').includes(scope);
  }

  async function callApi(method, path, body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Errore API ${response.status}`);
    return value;
  }

  function makeServer(req) {
    const server = new Server(
      { name: 'tommi-brain', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: 'Brain è un archivio personale. Prima di aggiornare una nota, leggila e usa modified_at per evitare conflitti. Chiedi conferma prima di spostare nel cestino o ripristinare una versione.' }
    );
    const tools = [];
    const handlers = new Map();
    const register = (name, title, description, schema, scope, annotations, handler, meta = {}) => {
      const input = z.object(schema);
      tools.push({
        name, title, description, inputSchema: z.toJSONSchema(input),
        annotations: { ...annotations, openWorldHint: false },
        securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }], ...meta }
      });
      handlers.set(name, async args => {
        if (!allowed(req, scope)) return challenge(scope);
        const parsed = input.safeParse(args || {});
        if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'Argomenti non validi' }] };
        try { return textResult(await handler(parsed.data)); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: e.message || 'Operazione non riuscita' }] }; }
      });
    };
    const read = { readOnlyHint: true, destructiveHint: false };
    const write = { readOnlyHint: false, destructiveHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true };

    register('get_profile', 'Profilo Brain', 'Identifica l’archivio Brain collegato.', {}, 'brain.read', read,
      async () => ({ id: profileId, name: 'Tommi Brain', nickname: 'Archivio personale Brain' }), { 'openai/profile': true });
    register('list_folders', 'Elenca cartelle', 'Mostra l’albero di cartelle e sottocartelle.', {}, 'brain.read', read,
      async () => callApi('GET', '/api/tree'));
    register('list_items', 'Elenca elementi', 'Mostra file e sottocartelle in una cartella. Usa path vuoto per la radice.', { path: z.string().default('') }, 'brain.read', read,
      async ({ path }) => callApi('GET', `/api/items?path=${encodeURIComponent(path)}`));
    register('search_files', 'Cerca file', 'Cerca nei nomi e nel contenuto dei file di testo.', { query: z.string().min(2) }, 'brain.read', read,
      async ({ query }) => { const result = await callApi('GET', `/api/search?q=${encodeURIComponent(query)}`); return { items: result.items.slice(0, 50), total: result.items.length }; });
    register('read_file', 'Leggi file', 'Legge un file di testo. Per note lunghe usa start e max_chars per leggere sezioni successive.', {
      path: z.string().min(1), start: z.number().int().min(0).default(0), max_chars: z.number().int().min(1).max(50_000).default(12_000)
    }, 'brain.read', read, async ({ path, start, max_chars }) => {
      const value = await callApi('GET', `/api/file?path=${encodeURIComponent(path)}`);
      if (!value.editable) return value;
      return { path: value.path, editable: true, content: value.content.slice(start, start + max_chars), start, total_chars: value.content.length, truncated: start + max_chars < value.content.length, modified_at: value.modifiedAt };
    });
    register('get_links', 'Collegamenti nota', 'Mostra collegamenti in uscita e note che citano una nota Markdown.', { path: z.string().min(1) }, 'brain.read', read,
      async ({ path }) => callApi('GET', `/api/links?path=${encodeURIComponent(path)}`));
    register('create_folder', 'Crea cartella', 'Crea una cartella o sottocartella; la cartella padre deve esistere.', { path: z.string().min(1) }, 'brain.write', write,
      async ({ path }) => callApi('POST', '/api/folders', { path }));
    register('create_note', 'Crea nota', 'Crea un nuovo file Markdown in una cartella esistente. path deve includere il nome e l’estensione .md o .markdown, per esempio Progetti/Idea.md.', { path: z.string().min(1), content: z.string().default('') }, 'brain.write', write,
      async ({ path, content }) => callApi('POST', '/api/files', { path, content }));
    register('update_note', 'Aggiorna nota', 'Sostituisce il contenuto di una nota Markdown. Richiede modified_at da read_file per evitare sovrascritture concorrenti.', {
      path: z.string().min(1), content: z.string(), modified_at: z.string().min(1)
    }, 'brain.write', destructive, async ({ path, content, modified_at }) => callApi('PUT', '/api/file', { path, content, modifiedAt: modified_at }));
    register('move_item', 'Sposta elemento', 'Sposta o rinomina un file o una cartella; la destinazione non deve esistere.', { from: z.string().min(1), to: z.string().min(1) }, 'brain.write', write,
      async ({ from, to }) => callApi('POST', '/api/move', { from, to }));
    register('delete_item', 'Sposta nel cestino', 'Sposta un file o una cartella nel cestino recuperabile. Chiedi conferma all’utente.', { path: z.string().min(1) }, 'brain.write', destructive,
      async ({ path }) => callApi('DELETE', '/api/items', { path }));
    register('list_trash', 'Elenca cestino', 'Mostra gli elementi recuperabili nel cestino.', {}, 'brain.read', read,
      async () => callApi('GET', '/api/trash'));
    register('restore_item', 'Ripristina elemento', 'Ripristina un elemento del cestino usando il suo ID.', { id: z.string().min(1) }, 'brain.write', write,
      async ({ id }) => callApi('POST', '/api/trash/restore', { id }));
    register('list_versions', 'Elenca versioni', 'Mostra le versioni precedenti di un file di testo.', { path: z.string().min(1) }, 'brain.read', read,
      async ({ path }) => callApi('GET', `/api/versions?path=${encodeURIComponent(path)}`));
    register('read_version', 'Leggi versione', 'Legge il contenuto di una versione precedente usando il suo ID.', { id: z.string().min(1) }, 'brain.read', read,
      async ({ id }) => callApi('GET', `/api/version?id=${encodeURIComponent(id)}`));
    register('restore_version', 'Ripristina versione', 'Ripristina una versione precedente e salva la versione attuale nella cronologia. Chiedi conferma all’utente.', { id: z.string().min(1) }, 'brain.write', destructive,
      async ({ id }) => callApi('POST', '/api/versions/restore', { id }));
    const profile = tools.find(tool => tool.name === 'get_profile');
    profile.outputSchema = z.toJSONSchema(z.object({ id: z.string(), name: z.string(), nickname: z.string() }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const handler = handlers.get(request.params.name);
      if (!handler) return { isError: true, content: [{ type: 'text', text: 'Strumento sconosciuto' }] };
      return handler(request.params.arguments);
    });
    return server;
  }

  async function handle(req, res, url) {
    const now = Date.now();
    for (const [key, value] of codes) if (value.expires <= now) codes.delete(key);
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      if (req.method !== 'GET') return oauthError(res, 405, 'invalid_request', 'Metodo non consentito');
      return json(res, 200, { resource, authorization_servers: [issuer], scopes_supported: [...SCOPES] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (req.method !== 'GET') return oauthError(res, 405, 'invalid_request', 'Metodo non consentito');
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
        client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES]
      });
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      const params = url.searchParams;
      const scopes = (params.get('scope') || 'brain.read brain.write').split(/\s+/).filter(Boolean);
      const state = params.get('state') || '';
      const challenge = params.get('code_challenge') || '';
      if (params.get('response_type') !== 'code' || params.get('client_id') !== CHATGPT_CLIENT_ID || params.get('redirect_uri') !== CHATGPT_REDIRECT || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || params.get('resource') !== resource || scopes.some(scope => !SCOPES.has(scope)) || !scopes.length || !state || state.length > 1024) return authorizationError(res, params, 'invalid_request', 'Richiesta OAuth non valida');
      const requestId = authorizationRequest(state, challenge, [...new Set(scopes)].join(' '));
      const permissions = scopes.includes('brain.write') ? 'lettura e modifica' : 'sola lettura';
      const html = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collega ChatGPT a Brain</title><main><h1>Collega ChatGPT a Brain</h1><p>ChatGPT chiede accesso in ${permissions} al tuo archivio personale. Autorizza solo se hai iniziato tu il collegamento. Questa richiesta resta valida per 30 minuti.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><label>Password Brain <input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Autorizza</button></form></main></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const requestId = form.get('request_id') || '';
      const grant = verifyAuthorizationRequest(requestId);
      if (!grant) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        return res.end('<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Richiesta scaduta</title><main><h1>Richiesta scaduta</h1><p>Chiudi questa pagina e avvia di nuovo il collegamento da ChatGPT. Apri la nuova pagina Brain e autorizza entro 30 minuti.</p></main></html>');
      }
      const attemptKey = 'oauth-password';
      const attempt = loginAttempts.get(attemptKey) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return oauthError(res, 429, 'access_denied', 'Troppi tentativi, riprova tra cinque minuti');
      if (attempt.until) { attempt.count = 0; attempt.until = 0; }
      const candidate = scryptSync(form.get('password') || '', 'tommi-md-brain-login-v1', 64);
      const expected = scryptSync(password, 'tommi-md-brain-login-v1', 64);
      if (!timingSafeEqual(candidate, expected)) {
        attempt.count++;
        attempt.until = attempt.count >= 5 ? Date.now() + 5 * 60_000 : 0;
        loginAttempts.set(attemptKey, attempt);
        return oauthError(res, 401, 'access_denied', 'Password errata; torna indietro e riprova');
      }
      loginAttempts.delete(attemptKey);
      if (codes.size >= 1000) return oauthError(res, 429, 'temporarily_unavailable', 'Troppe autorizzazioni in corso');
      const code = randomId();
      codes.set(hash(code), { state: grant.state, challenge: grant.challenge, scope: grant.scope, expires: Date.now() + AUTH_CODE_MS });
      const redirect = new URL(CHATGPT_REDIRECT);
      redirect.searchParams.set('code', code);
      if (grant.state) redirect.searchParams.set('state', grant.state);
      redirect.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('client_id') !== CHATGPT_CLIENT_ID || form.get('resource') !== resource) return oauthError(res, 400, 'invalid_client', 'Client o risorsa non validi');
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') || '';
        const grant = codes.get(hash(code));
        codes.delete(hash(code));
        const verifier = form.get('code_verifier') || '';
        if (!grant || grant.expires <= Date.now() || form.get('redirect_uri') !== CHATGPT_REDIRECT || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || hash(verifier) !== grant.challenge) return oauthError(res, 400, 'invalid_grant', 'Codice o PKCE non validi');
        return json(res, 200, issueTokens(grant.scope));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const refresh = verifyToken(form.get('refresh_token'), 'refresh');
        if (!refresh) return oauthError(res, 400, 'invalid_grant', 'Refresh token non valido');
        return json(res, 200, issueTokens(refresh.scope));
      }
      return oauthError(res, 400, 'unsupported_grant_type', 'Grant non supportato');
    }
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { Allow: 'POST' });
      const raw = await readBody(req, 1_048_576);
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
      const server = makeServer(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await transport.close();
        await server.close();
      }
      return;
    }
    return false;
  }

  return { handle };
}
