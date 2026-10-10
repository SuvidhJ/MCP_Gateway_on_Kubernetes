// Spike WooCommerce MCP server (E5/E8/DoD walk). Not product code, but it exercises every decision from 06-depth/04:
//  - WC REST key over in-cluster HTTP with Basic auth + X-Forwarded-Proto: https (is_ssl() true via wp-config-docker)
//  - ?rest_route= so it works with plain or pretty permalinks
//  - _fields trimming (token budget), dates normalised to *_gmt + 'Z', money as strings
//  - WC error codes mapped to isError text the model can act on; no outputSchema (avoids woocommerce#64195 class)
// Env: PORT (8080), WC_URL (http://wordpress.store.svc.cluster.local), WC_CK, WC_CS, STORE (slug shown in descriptions)
import http from 'node:http';
import * as z from 'zod/v4';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const PORT = Number(process.env.PORT ?? 8080);
const WC_URL = process.env.WC_URL ?? 'http://wordpress.store.svc.cluster.local';
const AUTH = 'Basic ' + Buffer.from(`${process.env.WC_CK}:${process.env.WC_CS}`).toString('base64');
const STORE = process.env.STORE ?? 'store';
const TIMEOUT_MS = Number(process.env.WC_TIMEOUT_MS ?? 8000);

class WcError extends Error { constructor(status, code, message, data) { super(message); Object.assign(this, { status, code, data }); } }

async function wc(method, route, { query = {}, body } = {}) {
  const u = new URL(WC_URL + '/');
  u.searchParams.set('rest_route', route);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(`${k}[]`, x)); else u.searchParams.set(k, String(v));
  }
  const res = await fetch(u, {
    method, signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: AUTH, 'x-forwarded-proto': 'https', accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new WcError(res.status, 'non_json', `store returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new WcError(res.status, json.code, json.message, json.data);
  return { json, total: Number(res.headers.get('x-wp-total') ?? NaN) };
}

const iso = (gmt) => (gmt ? `${gmt}Z` : null);   // WC returns 'Y-m-d\TH:i:s' with no offset, even for *_gmt
const orderSummary = (o) => ({
  id: o.id, number: o.number, status: o.status, currency: o.currency, total: o.total,
  created_at: iso(o.date_created_gmt), customer: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || null,
  items: (o.line_items ?? []).map(li => ({ name: li.name, quantity: li.quantity, total: li.total })),
  payment_method: o.payment_method_title || o.payment_method || null,
});
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { items: data } : data });
function fail(e, what) {
  if (e instanceof WcError) {
    const map = {
      woocommerce_rest_authentication_error: `store credentials rejected (${e.message})`,
      woocommerce_rest_cannot_view: `the store user is not allowed to view ${what}`,
      woocommerce_rest_cannot_create: `the store user is not allowed to create ${what}`,
      woocommerce_rest_cannot_edit: `the store user is not allowed to edit ${what}`,
      woocommerce_rest_cannot_delete: `the store user is not allowed to delete ${what}`,
      woocommerce_rest_shop_order_invalid_id: `order not found`,
      woocommerce_rest_product_invalid_id: `product not found`,
      product_invalid_sku: `a product with that SKU already exists`,
      rest_invalid_param: `invalid parameters: ${Object.values(e.data?.params ?? {}).join('; ') || e.message}`,
    };
    return { isError: true, content: [{ type: 'text', text: `${STORE}: ${map[e.code] ?? `${e.code}: ${e.message}`} (HTTP ${e.status})` }] };
  }
  const timedOut = e?.name === 'TimeoutError';
  return { isError: true, content: [{ type: 'text', text: `${STORE}: store unavailable (${timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : e?.cause?.code ?? e?.message})` }] };
}

function buildServer() {
  const s = new McpServer({ name: `woo-${STORE}`, version: '0.0.1' });
  s.registerTool('list_products', {
    title: 'List products', description: `List products in the ${STORE} WooCommerce store. Optional text search.`,
    inputSchema: z.object({ search: z.string().optional(), per_page: z.number().int().min(1).max(50).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ search, per_page }) => {
    try {
      const { json, total } = await wc('GET', '/wc/v3/products', { query: { search, per_page, _fields: 'id,name,sku,price,regular_price,status,stock_status,permalink' } });
      return ok({ total, products: json });
    } catch (e) { return fail(e, 'products'); }
  });
  s.registerTool('create_product', {
    title: 'Create product', description: `Create a simple product in the ${STORE} store. status=publish makes it visible on the storefront immediately; draft hides it.`,
    inputSchema: z.object({ name: z.string().min(1).max(200), regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/), sku: z.string().max(64).optional(),
      description: z.string().max(2000).optional(), status: z.enum(['publish', 'draft']) }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => {
    try {
      const { json } = await wc('POST', '/wc/v3/products', { body: { type: 'simple', ...args } });
      return ok({ id: json.id, name: json.name, sku: json.sku, price: json.price, status: json.status, permalink: json.permalink });
    } catch (e) { return fail(e, 'products'); }
  });
  s.registerTool('list_orders', {
    title: 'List orders', description: `List orders in the ${STORE} store, newest first. Filter by status and/or created_after (ISO 8601, UTC).`,
    inputSchema: z.object({ status: z.array(z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'])).optional(),
      created_after: z.string().optional(), per_page: z.number().int().min(1).max(50).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ status, created_after, per_page }) => {
    try {
      const { json, total } = await wc('GET', '/wc/v3/orders', { query: { status, after: created_after, dates_are_gmt: created_after ? 'true' : undefined, per_page,
        _fields: 'id,number,status,currency,total,date_created_gmt,billing,line_items,payment_method,payment_method_title' } });
      return ok({ total, orders: json.map(orderSummary) });
    } catch (e) { return fail(e, 'orders'); }
  });
  s.registerTool('get_order', {
    title: 'Get order', description: `Get one order from the ${STORE} store by id.`,
    inputSchema: z.object({ id: z.number().int().positive() }), annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    try { const { json } = await wc('GET', `/wc/v3/orders/${id}`); return ok({ ...orderSummary(json), customer_note: json.customer_note || null, shipping_total: json.shipping_total }); }
    catch (e) { return fail(e, `order ${id}`); }
  });
  s.registerTool('update_order_status', {
    title: 'Update order status', description: `Change the status of an order in the ${STORE} store.`,
    inputSchema: z.object({ id: z.number().int().positive(), status: z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled']) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ id, status }) => {
    try {
      const { json } = await wc('PUT', `/wc/v3/orders/${id}`, { body: { status, manual_update: true } });
      return ok({ id: json.id, status: json.status, modified_at: iso(json.date_modified_gmt) });
    } catch (e) { return fail(e, `order ${id}`); }
  });
  return s;
}

const handler = toNodeHandler(createMcpHandler(() => buildServer(), { keepAliveMs: 15_000 }));
http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url.startsWith('/mcp')) return handler(req, res);
  res.writeHead(404); res.end();
}).listen(PORT, () => console.error(`[woo-mcp ${STORE}] :${PORT} -> ${WC_URL}`));
process.on('SIGTERM', () => process.exit(0));
