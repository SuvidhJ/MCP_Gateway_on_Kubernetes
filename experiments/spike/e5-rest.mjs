// E5 REST battery. Run INSIDE the cluster (kubectl -n exp exec -i deploy/spike-gateway -- node - < spike/e5-rest.mjs)
// Checks auth paths, key scope, least-privilege caps, error shapes, dates. Checkout is done separately (e5-checkout.mjs).
const WP = 'http://wordpress.store.svc.cluster.local';
const RW = 'Basic ' + Buffer.from('ck_e5rw000000000000000000000000000000000001:cs_e5rw000000000000000000000000000000000002').toString('base64');
const RO = 'Basic ' + Buffer.from('ck_e5readonly000000000000000000000000000002:cs_e5readonly000000000000000000000000000002').toString('base64');
const BAD = 'Basic ' + Buffer.from('ck_e5rw000000000000000000000000000000000001:cs_wrong').toString('base64');
async function call(label, method, path, { auth = RW, xfp = true, body, pretty = false } = {}) {
  const url = pretty ? `${WP}/wp-json${path}` : `${WP}/?rest_route=${encodeURIComponent(path.split('?')[0])}${path.includes('?') ? '&' + path.split('?')[1] : ''}`;
  const h = { accept: 'application/json', ...(auth ? { authorization: auth } : {}), ...(xfp ? { 'x-forwarded-proto': 'https' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 80); }
  const summary = Array.isArray(j) ? `array(${j.length}) total=${r.headers.get('x-wp-total')}` : (j?.code ? `${j.code}: ${String(j.message).slice(0, 90)}` : JSON.stringify(j).slice(0, 110));
  console.log(`${label.padEnd(52)} ${method.padEnd(6)} ${r.status}  ${summary}`);
  return { status: r.status, j };
}
console.log('--- auth paths');
await call('RW key, Basic, NO X-Forwarded-Proto', 'GET', '/wc/v3/products?per_page=1', { xfp: false });
await call('RW key, Basic, X-Forwarded-Proto: https', 'GET', '/wc/v3/products?per_page=1');
await call('RW key, pretty /wp-json path', 'GET', '/wc/v3/products?per_page=1', { pretty: true });
await call('wrong secret', 'GET', '/wc/v3/products?per_page=1', { auth: BAD });
await call('no auth', 'GET', '/wc/v3/orders', { auth: null });
await call('RO key GET', 'GET', '/wc/v3/products?per_page=1', { auth: RO });
await call('RO key POST (scope=read)', 'POST', '/wc/v3/products', { auth: RO, body: { name: 'x', regular_price: '1' } });
await call('RW key on wp/v2/users/me (needs auth; out of WC scope)', 'GET', '/wp/v2/users/me');
await call('RW key on wp/v2/settings (out of WC scope)', 'GET', '/wp/v2/settings');
await call('RW key on wp/v2/posts POST (out of WC scope)', 'POST', '/wp/v2/posts', { body: { title: 'x' } });
console.log('--- least privilege (mcp_store_agent)');
const created = await call('create product status=draft', 'POST', '/wc/v3/products', { body: { name: 'E5 Draft', regular_price: '10', sku: 'E5-DRAFT-' + Date.now(), status: 'draft' } });
await call('create product, no status (schema default?)', 'POST', '/wc/v3/products', { body: { name: 'E5 Default', regular_price: '11', sku: 'E5-DEF-' + Date.now() } }).then(r => console.log('   -> status of product created without status:', r.j?.status));
await call('duplicate SKU', 'POST', '/wc/v3/products', { body: { name: 'dup', regular_price: '1', sku: 'MUG-1' } });
await call('bad price type', 'POST', '/wc/v3/products', { body: { name: 'bad', regular_price: 12 } });
await call('DELETE product (no delete_products cap)', 'DELETE', `/wc/v3/products/${created.j?.id}?force=true`);
await call('settings (no manage_woocommerce)', 'GET', '/wc/v3/settings/general');
await call('customers list', 'GET', '/wc/v3/customers');
await call('coupons list (no coupon caps)', 'GET', '/wc/v3/coupons');
await call('reports/sales', 'GET', '/wc/v3/reports/sales');
await call('get product 999999', 'GET', '/wc/v3/products/999999');
await call('get order 999999', 'GET', '/wc/v3/orders/999999');
await call('list orders status=bogus', 'GET', '/wc/v3/orders?status=bogus');
await call('list products _fields trimmed', 'GET', '/wc/v3/products?per_page=2&_fields=id,name,price').then(r => console.log('   ->', JSON.stringify(r.j)));
