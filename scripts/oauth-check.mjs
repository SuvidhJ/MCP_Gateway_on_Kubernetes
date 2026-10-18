// End-to-end OAuth check against the deployed gateway: a real MCP SDK client signs in with only the gateway URL
// (discovery -> dynamic registration -> browser login + consent -> PKCE code exchange -> tool calls), then the
// Client ID Metadata Document path (as Claude Code, client_id https://claude.ai/oauth/claude-code-client-metadata),
// refresh rotation, replay/theft detection, revocation, and the authorization server's input checks.
// The "browser" is plain fetch with the session cookie of a test user.
// Usage: node scripts/oauth-check.mjs   Env: ORIGIN (default http://localhost:8080), ADMIN_PASSWORD (required)
import crypto from 'node:crypto';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8080';
const MCP = `${ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:53682/callback';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`); };
const check = (cond, m, extra = '') => (cond ? ok(m) : bad(`${m}${extra ? `: ${extra}` : ''}`));

// ---- a cookie jar per "browser" ----
class Browser {
  cookies = new Map();
  async fetch(url, init = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(new URL(url, ORIGIN), { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  }
  async login(email, password) {
    const r = await this.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return (await r.json()).csrf;
  }
}
const form = (o) => new URLSearchParams(o).toString();
const hidden = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// ---- an in-memory OAuthClientProvider (what a desktop client keeps on disk) ----
class Provider {
  constructor(name, metadataUrl) { this.name = name; this.clientMetadataUrl = metadataUrl; this.info = undefined; this.tok = undefined; this.verifier = ''; this.authUrl = undefined; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: this.name, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return (this.st = crypto.randomBytes(8).toString('hex')); }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t) { this.tok = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(s) { this.discovery = s; }
  discoveryState() { return this.discovery; }
}
/** The app's callback leg: hand the code and iss back to the SDK. */
const finish = (p, location) => { const u = new URL(location); return auth(p, { serverUrl: MCP, authorizationCode: u.searchParams.get('code'), iss: u.searchParams.get('iss') ?? undefined }); };

/** The browser leg: open the authorization URL, sign in if asked, allow, return the redirect back to the app. */
async function approve(browser, authUrl, decision = 'allow') {
  let r = await browser.fetch(authUrl);
  let html = await r.text();
  if (html.includes('action="/oauth/login"')) throw new Error('not signed in');
  const req = hidden(html, 'req'), csrf = hidden(html, 'csrf');
  r = await browser.fetch('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req, csrf, decision }) });
  return { status: r.status, location: r.headers.get('location'), html };
}

async function main() {
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) throw new Error('ADMIN_PASSWORD is required');
  const admin = new Browser();
  const acsrf = await admin.login('admin@urumi.local', adminPw);
  const api = (path, init = {}) => admin.fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-csrf-token': acsrf, ...init.headers } });

  // a fresh member who will sign in with OAuth
  const email = `oauth-${crypto.randomBytes(3).toString('hex')}@urumi.local`;
  const m = await (await api('/members', { method: 'POST', body: JSON.stringify({ email, name: 'OAuth user', role: 'member' }) })).json();
  const user = new Browser();
  const ucsrf = await user.login(email, m.password);
  await user.fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ucsrf }, body: JSON.stringify({ current: m.password, password: 'oauth-user-password-1' }) });

  console.log('== discovery');
  let r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  const wa = r.headers.get('www-authenticate') ?? '';
  check(r.status === 401 && wa.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`) && wa.includes('scope="mcp"'), '401 challenge names the resource metadata and scope', wa);
  const prm = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
  check(prm.resource === MCP && prm.authorization_servers?.[0] === ORIGIN, 'protected resource metadata (RFC 9728)', JSON.stringify(prm));
  const asm = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
  check(asm.issuer === ORIGIN && asm.code_challenge_methods_supported?.includes('S256') && asm.client_id_metadata_document_supported === true && asm.authorization_response_iss_parameter_supported === true,
    'authorization server metadata (RFC 8414: S256, CIMD, iss)');
  r = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, { method: 'OPTIONS' });
  check(r.headers.get('access-control-allow-origin') === '*', 'metadata is CORS-readable (browser-based clients)');

  console.log('== SDK client: dynamic registration + browser consent + PKCE');
  const p = new Provider('oauth-check (DCR)');
  let res = await auth(p, { serverUrl: MCP });
  check(res === 'REDIRECT' && p.info?.client_id?.startsWith('dcr_') && p.authUrl, `registered (${p.info?.client_id}) and got an authorization URL`);
  const anon = new Browser();
  r = await anon.fetch(p.authUrl);
  check((await r.text()).includes('action="/oauth/login"'), 'not signed in: the authorization page asks for a login first');
  r = await anon.fetch('/oauth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ next: `${p.authUrl.pathname}${p.authUrl.search}`, email, password: 'wrong-password-x' }) });
  check(r.status === 401, 'wrong password on the OAuth login page -> 401');
  r = await anon.fetch('/oauth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ next: '//evil.example/x', email, password: 'oauth-user-password-1' }) });
  check(r.status === 400, 'login `next` cannot be an open redirect');
  r = await anon.fetch('/oauth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ next: `${p.authUrl.pathname}${p.authUrl.search}`, email, password: 'oauth-user-password-1' }) });
  check(r.status === 303 && r.headers.get('location')?.startsWith('/oauth/authorize?'), 'login on the OAuth page returns to the authorization request');
  let a = await approve(anon, p.authUrl);
  check(a.html.includes('oauth-check (DCR)') && a.html.includes('registered itself'), 'consent names the app and warns it is self-registered');
  check(a.html.includes('127.0.0.1:53682') && a.html.includes('localhost'), 'consent shows where it redirects (and the localhost warning)');
  const back = new URL(a.location);
  check(a.status === 302 && back.origin + back.pathname === REDIRECT && back.searchParams.get('state') === p.st && back.searchParams.get('iss') === ORIGIN && back.searchParams.get('code'),
    'redirected back with code, state and iss (RFC 9207)', a.location);
  res = await auth(p, { serverUrl: MCP, authorizationCode: back.searchParams.get('code'), iss: back.searchParams.get('iss') });
  check(res === 'AUTHORIZED' && p.tok?.access_token?.startsWith('uat_') && p.tok?.refresh_token, 'code exchanged for tokens (PKCE)');

  const client = new Client({ name: 'oauth-check', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: p }));
  const { tools } = await client.listTools();
  check(tools.some((t) => t.name === 'store__list_orders'), `tools/list over OAuth (${tools.length} tools)`);
  const call = await client.callTool({ name: 'store__list_orders', arguments: {} });
  check(!call.isError, 'tool call over OAuth');
  await client.close();
  const audit = await (await api(`/audit?user=${encodeURIComponent(email)}`)).json();
  check(audit.items.some((i) => i.via === 'oauth:oauth-check (DCR)' && i.tool === 'list_orders' && i.outcome === 'ok'), 'audited as the user, via oauth:<client name>');

  console.log('== refresh rotation and theft detection');
  const t1 = p.tok;
  const tok = (body) => fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  r = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: p.info.client_id, resource: MCP });
  const t2 = await r.json();
  check(r.status === 200 && t2.refresh_token && t2.refresh_token !== t1.refresh_token, 'refresh gives a new refresh token (rotation)');
  r = await fetch(MCP, { method: 'POST', headers: { authorization: `Bearer ${t1.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check(r.status === 401, 'the previous access token stops working after a refresh');
  r = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: p.info.client_id });
  check(r.status === 400 && (await r.json()).error === 'invalid_grant', 'reusing a rotated refresh token -> invalid_grant');
  r = await fetch(MCP, { method: 'POST', headers: { authorization: `Bearer ${t2.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check(r.status === 401, '...and it revokes the whole grant (the new tokens die too)');

  console.log('== Client ID Metadata Document (acting as Claude Code)');
  const CC = 'https://claude.ai/oauth/claude-code-client-metadata';
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const ccRedirect = 'http://localhost:41234/callback'; // the document lists http://localhost/callback: any port on loopback
  const authz = (o) => `/oauth/authorize?${form({ response_type: 'code', client_id: CC, redirect_uri: ccRedirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: MCP, scope: 'mcp', ...o })}`;
  a = await approve(user, authz({}));
  check(a.html.includes('Allow Claude Code?') && a.html.includes('Identified by its metadata'), 'consent shows the name from the fetched metadata document', a.html.slice(0, 120));
  const ccBack = new URL(a.location);
  r = await tok({ grant_type: 'authorization_code', code: ccBack.searchParams.get('code'), client_id: CC, redirect_uri: ccRedirect, code_verifier: crypto.randomBytes(32).toString('base64url'), resource: MCP });
  check(r.status === 400 && (await r.json()).error === 'invalid_grant', 'wrong PKCE verifier -> invalid_grant');
  a = await approve(user, authz({}));
  const code2 = new URL(a.location).searchParams.get('code');
  r = await tok({ grant_type: 'authorization_code', code: code2, client_id: CC, redirect_uri: ccRedirect, code_verifier: verifier, resource: MCP });
  const cct = await r.json();
  check(r.status === 200 && cct.access_token, 'Claude Code (CIMD) gets tokens');
  r = await tok({ grant_type: 'authorization_code', code: code2, client_id: CC, redirect_uri: ccRedirect, code_verifier: verifier, resource: MCP });
  check(r.status === 400, 'replaying the code -> invalid_grant');
  r = await fetch(MCP, { method: 'POST', headers: { authorization: `Bearer ${cct.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check(r.status === 401, '...and the replay revokes what the code produced');
  a = await approve(user, authz({}), 'deny');
  check(new URL(a.location).searchParams.get('error') === 'access_denied', 'Deny -> error=access_denied back to the app');

  console.log('== authorization request validation');
  r = await user.fetch(authz({ redirect_uri: 'http://evil.example/callback' }));
  check(r.status === 400 && !r.headers.get('location'), 'unregistered redirect_uri: error page, never a redirect');
  r = await user.fetch(authz({ code_challenge: '', code_challenge_method: '' }));
  check(r.status === 302 && new URL(r.headers.get('location')).searchParams.get('error') === 'invalid_request', 'missing PKCE -> invalid_request (redirected)');
  r = await user.fetch(authz({ code_challenge_method: 'plain' }));
  check(r.status === 302 && new URL(r.headers.get('location')).searchParams.get('error') === 'invalid_request', 'PKCE plain -> invalid_request');
  r = await user.fetch(authz({ resource: 'https://evil.example/mcp' }));
  check(r.status === 302 && new URL(r.headers.get('location')).searchParams.get('error') === 'invalid_target', 'foreign resource -> invalid_target (RFC 8707)');
  for (const bad_ of ['https://169.254.169.254/latest/meta-data', 'https://kubernetes.default.svc/x.json', 'https://example.com/client.json', 'http://claude.ai/oauth/claude-code-client-metadata']) {
    r = await user.fetch(authz({ client_id: bad_ }));
    check(r.status === 400, `client_id ${bad_} refused (SSRF guard / not a valid document / not https)`);
  }
  r = await user.fetch('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req: 'eyJ4IjoxfQ.forged', csrf: 'x', decision: 'allow' }) });
  check(r.status === 400, 'forged consent request -> refused');
  a = await (async () => { const g = await user.fetch(authz({})); const h = await g.text(); return user.fetch('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ req: hidden(h, 'req'), csrf: 'not-the-token', decision: 'allow' }) }); })();
  check(a.status === 403, 'consent without the session CSRF token -> refused');
  r = await fetch(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }) });
  check(r.status === 400, 'DCR: plain-http non-loopback redirect refused');
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://ok.example/cb#frag']) {
    r = await fetch(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: [u] }) });
    check(r.status === 400, `DCR: redirect ${u} refused`);
  }
  r = await fetch(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] }) });
  check(r.status === 201, 'DCR: an app scheme (RFC 8252) is accepted');
  r = await tok({ grant_type: 'password', username: email, password: 'x' });
  check(r.status === 400 && (await r.json()).error === 'unsupported_grant_type', 'password grant not supported');

  console.log('== revocation and user lifecycle');
  const p2 = new Provider('oauth-check (revoke)');
  await auth(p2, { serverUrl: MCP });
  a = await approve(user, p2.authUrl);
  await finish(p2, a.location);
  const callWith = (t) => fetch(MCP, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then((x) => x.status);
  check((await callWith(p2.tok.access_token)) === 200, 'second app connected');
  const grants = await (await user.fetch('/api/oauth/grants')).json();
  const g = grants.find((x) => x.clientName === 'oauth-check (revoke)' && !x.revokedAt);
  check(!!g, 'it is listed under Connected apps');
  r = await user.fetch(`/api/oauth/grants/${g.id}`, { method: 'DELETE', headers: { 'x-csrf-token': ucsrf } });
  check(r.status === 204 && (await callWith(p2.tok.access_token)) === 401, 'revoked from the dashboard -> its next call is 401');
  const rej = await (await api(`/audit?user=${encodeURIComponent(email)}&outcome=rejected`)).json();
  check(rej.items.some((i) => i.via === 'oauth:oauth-check (revoke)'), 'the refused call is audited under the user');
  const p3 = new Provider('oauth-check (disable)');
  await auth(p3, { serverUrl: MCP });
  a = await approve(user, p3.authUrl);
  await finish(p3, a.location);
  const members = await (await api('/members')).json();
  const uid = members.find((x) => x.email === email).id;
  await api(`/members/${uid}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
  check((await callWith(p3.tok.access_token)) === 401, 'disabling the user ends their OAuth access');
  r = await tok({ grant_type: 'refresh_token', refresh_token: p3.tok.refresh_token, client_id: p3.info.client_id });
  check(r.status === 400, '...and refresh is refused');
  await api(`/members/${uid}`, { method: 'DELETE' });

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e); console.log(`RESULT: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
