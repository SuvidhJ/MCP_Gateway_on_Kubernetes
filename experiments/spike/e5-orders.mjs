// E5 order battery (in-cluster, as mcp-agent via RW key). Usage: kubectl -n exp exec -i deploy/spike-gateway -- node --input-type=module - < spike/e5-orders.mjs
const WP = 'http://wordpress.store.svc.cluster.local';
const RW = 'Basic ' + Buffer.from('ck_e5rw000000000000000000000000000000000001:cs_e5rw000000000000000000000000000000000002').toString('base64');
const H = { authorization: RW, 'x-forwarded-proto': 'https', accept: 'application/json' };
const get = async (route, q = '') => { const r = await fetch(`${WP}/?rest_route=${encodeURIComponent(route)}${q}`, { headers: H }); return { status: r.status, total: r.headers.get('x-wp-total'), j: await r.json() }; };
const put = async (route, body) => { const r = await fetch(`${WP}/?rest_route=${encodeURIComponent(route)}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
const mode = process.env.MODE ?? 'full';
const list = await get('/wc/v3/orders', '&status[]=processing&_fields=id,status,date_created,date_created_gmt,total,currency,created_via,customer_id,customer_note');
console.log('list processing ->', list.status, 'total', list.total, JSON.stringify(list.j));
const now = new Date(); const since = new Date(now.getTime() - 3600e3).toISOString().slice(0, 19);
const after = await get('/wc/v3/orders', `&after=${since}&dates_are_gmt=true&_fields=id`);
console.log(`after=${since} (gmt) ->`, after.status, JSON.stringify(after.j));
const afterLocal = await get('/wc/v3/orders', `&after=${since}&_fields=id`);
console.log(`after=${since} (site tz, no dates_are_gmt) ->`, afterLocal.status, JSON.stringify(afterLocal.j));
const id = list.j?.[list.j.length - 1]?.id;
const one = await get(`/wc/v3/orders/${id}`);
console.log('get order', id, '->', one.status, 'date_created', one.j.date_created, 'date_created_gmt', one.j.date_created_gmt, 'date_paid', one.j.date_paid, 'payment_method', one.j.payment_method, 'needs_payment', one.j.needs_payment);
if (mode === 'full') {
  const up = await put(`/wc/v3/orders/${id}`, { status: 'completed', manual_update: true });
  console.log('update -> completed', up.status, up.j.code ?? up.j.status, 'date_completed_gmt', up.j.date_completed_gmt);
  const notes = await get(`/wc/v3/orders/${id}/notes`);
  console.log('notes ->', notes.status, JSON.stringify((notes.j ?? []).map?.(n => ({ note: n.note, author: n.author, added_by_user: n.added_by_user })) ?? notes.j));
  const weird = await put(`/wc/v3/orders/${id}`, { status: 'pending' });
  console.log('completed -> pending (no transition rules?)', weird.status, weird.j.code ?? weird.j.status);
}
if (mode === 'edit-only') {
  const other = list.j?.[0]?.id;
  const up = await put(`/wc/v3/orders/${other}`, { status: 'on-hold' });
  console.log(`update guest order ${other} -> on-hold`, up.status, up.j.code ?? up.j.status, up.j.message ?? '');
}
