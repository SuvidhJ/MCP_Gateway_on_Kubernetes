// E5 storefront checkout as a guest buyer through Traefik (Store API, COD). Run on the host.
// Usage: node spike/e5-checkout.mjs [baseUrl] [productId] [note]
const base = process.argv[2] ?? 'http://store.127.0.0.1.nip.io:8080';
const productId = Number(process.argv[3] ?? 10);
const note = process.argv[4] ?? '';
const r1 = await fetch(`${base}/wp-json/wc/store/v1/cart`);
const cartToken = r1.headers.get('cart-token'), nonce = r1.headers.get('nonce');
console.log('cart GET', r1.status, 'cart-token', !!cartToken, 'nonce', !!nonce);
const h = { 'content-type': 'application/json', 'cart-token': cartToken, nonce };
const r2 = await fetch(`${base}/wp-json/wc/store/v1/cart/add-item`, { method: 'POST', headers: h, body: JSON.stringify({ id: productId, quantity: 2 }) });
const cart = await r2.json();
console.log('add-item', r2.status, cart.code ?? '', 'items', cart.items?.length, 'total', cart.totals?.total_price, cart.totals?.currency_code,
  'shipping rates', JSON.stringify(cart.shipping_rates?.[0]?.shipping_rates?.map(r => r.method_id)));
const addr = { first_name: 'Asha', last_name: 'Buyer', address_1: '1 MG Road', city: 'Bengaluru', state: 'KA', postcode: '560001', country: 'IN', email: 'asha@example.invalid', phone: '9999999999' };
const r3 = await fetch(`${base}/wp-json/wc/store/v1/checkout`, { method: 'POST', headers: h, body: JSON.stringify({ billing_address: addr, shipping_address: addr, payment_method: 'cod', customer_note: note }) });
const co = await r3.json();
console.log('checkout', r3.status, co.code ?? '', co.message ?? '', 'order_id', co.order_id, 'status', co.status, 'payment', co.payment_result?.payment_status);
