#!/usr/bin/env bash
# Idempotent store bootstrap (runs as uid 33 in a Job, same image as the store). Every step is check-then-act,
# so re-running it (Job retry, helm upgrade) converges instead of failing.
# Env: WORDPRESS_DB_HOST/USER/PASSWORD/NAME, STORE_URL, STORE_TITLE, STORE_ADMIN_USER/PASSWORD/EMAIL,
#      STORE_TIMEZONE, STORE_CURRENCY, STORE_COUNTRY, MCP_WC_USER, MCP_WC_CK, MCP_WC_CS (43-char ck_/cs_ keys).
set -euo pipefail
cd /usr/src/wordpress
t0=$(date +%s)
step() { echo "[$(( $(date +%s) - t0 ))s] $*"; }
wpq() { wp --path=/usr/src/wordpress --skip-plugins=woocommerce "$@"; }
wpc() { wp --path=/usr/src/wordpress "$@"; }
: "${STORE_URL:?}" "${STORE_ADMIN_PASSWORD:?}" "${MCP_WC_CK:?}" "${MCP_WC_CS:?}"
STORE_TITLE=${STORE_TITLE:-Urumi Store}; STORE_ADMIN_USER=${STORE_ADMIN_USER:-admin}
STORE_ADMIN_EMAIL=${STORE_ADMIN_EMAIL:-admin@store.invalid}; STORE_TIMEZONE=${STORE_TIMEZONE:-Asia/Kolkata}
STORE_CURRENCY=${STORE_CURRENCY:-INR}; STORE_COUNTRY=${STORE_COUNTRY:-IN:KA}; MCP_WC_USER=${MCP_WC_USER:-mcp-agent}
[ ${#MCP_WC_CK} -eq 43 ] && [ ${#MCP_WC_CS} -eq 43 ] || { echo "MCP_WC_CK/CS must be 43 chars (ck_/cs_ + 40 hex)"; exit 2; }

# 1. wait for the database (Helm hooks don't wait for readiness)
for i in $(seq 1 60); do
  php -r '$h=explode(":", getenv("WORDPRESS_DB_HOST")); exit(@mysqli_connect($h[0], getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME"), (int)($h[1] ?? 3306)) ? 0 : 1);' && break
  step "db not ready ($i)"; sleep 5
done

# 2. core + plugin
wpq core is-installed 2>/dev/null || { step "core install"; wpq core install --url="$STORE_URL" --title="$STORE_TITLE" \
  --admin_user="$STORE_ADMIN_USER" --admin_password="$STORE_ADMIN_PASSWORD" --admin_email="$STORE_ADMIN_EMAIL" --skip-email; }
wpq option update home "$STORE_URL" >/dev/null; wpq option update siteurl "$STORE_URL" >/dev/null
wpq plugin is-active woocommerce || { step "activate woocommerce"; wpq plugin activate woocommerce; }

# 3. store settings
wpc rewrite structure '/%postname%/' >/dev/null
wpc option update timezone_string "$STORE_TIMEZONE" >/dev/null
wpc option update woocommerce_coming_soon no >/dev/null
wpc option update woocommerce_store_pages_only no >/dev/null
wpc option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
wpc option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
wpc option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
wpc wc payment_gateway update cod --enabled=true --user="$STORE_ADMIN_USER" >/dev/null
if ! wpc wc shipping_zone_method list 0 --user="$STORE_ADMIN_USER" --format=ids | grep -q .; then
  wpc wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --user="$STORE_ADMIN_USER" >/dev/null
fi
# HPOS stays off after a WP-CLI activation (E5); real new shops get it, so enable explicitly.
wpc wc hpos status 2>/dev/null | grep -q "HPOS enabled?: yes" || wpc wc hpos enable >/dev/null
step "settings: permalinks='$(wpc option get permalink_structure)' coming_soon=$(wpc option get woocommerce_coming_soon) hpos=$(wpc wc hpos status | grep -o 'HPOS enabled?: [a-z]*')"

# 4. least-privilege role + user (never an administrator)
wpc role exists mcp_store_agent 2>/dev/null || wpc role create mcp_store_agent "MCP Store Agent" >/dev/null
wpc cap add mcp_store_agent read read_private_products edit_products edit_published_products edit_others_products \
  publish_products assign_product_terms read_private_shop_orders edit_shop_orders edit_others_shop_orders \
  edit_published_shop_orders edit_private_shop_orders >/dev/null
wpc user get "$MCP_WC_USER" >/dev/null 2>&1 || wpc user create "$MCP_WC_USER" "$MCP_WC_USER@store.invalid" \
  --role=mcp_store_agent --user_pass="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >/dev/null

# 5. WooCommerce REST key from the Secret, checked insert (exits non-zero if the row is not there afterwards)
cat > /tmp/urumi-key.php <<'PHP'
<?php
global $wpdb;
$ck = getenv('MCP_WC_CK'); $cs = getenv('MCP_WC_CS');
$user = get_user_by('login', getenv('MCP_WC_USER'));
if (!$user) { fwrite(STDERR, "no user\n"); exit(1); }
$hash = hash_hmac('sha256', $ck, 'wc-api');
$table = $wpdb->prefix . 'woocommerce_api_keys';
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key=%s", $hash));
if (!$id) {
  $ok = $wpdb->insert($table, ['user_id' => $user->ID, 'description' => 'urumi woo-mcp (bootstrap)', 'permissions' => 'read_write',
    'consumer_key' => $hash, 'consumer_secret' => $cs, 'truncated_key' => substr($ck, -7)]);
  if ($ok !== 1) { fwrite(STDERR, "insert failed: {$wpdb->last_error}\n"); exit(1); }
  $id = $wpdb->insert_id; echo "inserted key $id for user {$user->ID}\n";
} else {
  $wpdb->update($table, ['consumer_secret' => $cs, 'user_id' => $user->ID, 'permissions' => 'read_write'], ['key_id' => $id]);
  echo "key $id present (secret synced)\n";
}
PHP
wpc eval-file /tmp/urumi-key.php

# 6. seed products (skip existing SKUs)
for p in "Urumi Mug|MUG-1|499" "Urumi Tee|TEE-1|899" "Urumi Cap|CAP-1|650"; do
  IFS='|' read -r name sku price <<<"$p"
  [ -n "$(wpc wc product list --sku="$sku" --user="$STORE_ADMIN_USER" --format=ids)" ] || \
    wpc wc product create --name="$name" --sku="$sku" --regular_price="$price" --status=publish --user="$STORE_ADMIN_USER" >/dev/null
done
step "products: $(wpc wc product list --user="$STORE_ADMIN_USER" --fields=id,sku,status --format=csv | tr '\n' ' ')"
step "bootstrap complete"
