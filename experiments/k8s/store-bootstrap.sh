#!/usr/bin/env bash
# E5 store bootstrap, run INSIDE the wordpress container as root (spike: the product uses an immutable image + Job).
#   kubectl -n store exec -i deploy/wordpress -- bash -s < k8s/store-bootstrap.sh
# Every wp call runs as www-data (uid 33), like the planned Job, and is check-then-act (idempotent).
set -euo pipefail
export WP_HOME=http://store.127.0.0.1.nip.io:8080
export MCP_WC_CK=ck_e5rw000000000000000000000000000000000001 MCP_WC_CS=cs_e5rw000000000000000000000000000000000002 MCP_WC_USER=mcp-agent
t0=$(date +%s)
step() { echo "[$(( $(date +%s) - t0 ))s] $*"; }
if [ ! -x /usr/local/bin/wp ]; then
  curl -fsSL -o /usr/local/bin/wp https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar
  chmod +x /usr/local/bin/wp
fi
wpw() { su -s /bin/bash www-data -c "cd /var/www/html && wp $(printf '%q ' "$@")"; }
step "wp-cli: $(wpw --version)  uid: $(su -s /bin/bash www-data -c 'id -u')"

wpw core is-installed 2>/dev/null || { step "core install"; wpw core install --url="$WP_HOME" --title="Urumi E5 Store" --admin_user=admin --admin_password=admin-e5-pass --admin_email=admin@store.invalid --skip-email; }
step "permalink_structure right after install: '$(wpw option get permalink_structure)'"
wpw plugin is-installed woocommerce || { step "install woocommerce 11.2.0"; wpw plugin install woocommerce --version=11.2.0; }
wpw plugin is-active woocommerce || { step "activate woocommerce"; wpw plugin activate woocommerce; }
step "woocommerce version: $(wpw plugin get woocommerce --field=version)"
step "DEFAULTS before setup -> coming_soon='$(wpw option get woocommerce_coming_soon 2>/dev/null || echo unset)' store_pages_only='$(wpw option get woocommerce_store_pages_only 2>/dev/null || echo unset)' hpos='$(wpw option get woocommerce_custom_orders_table_enabled 2>/dev/null || echo unset)' cod='$(wpw option get woocommerce_cod_settings --format=json 2>/dev/null || echo unset)'"

wpw rewrite structure '/%postname%/' --hard >/dev/null
wpw option update woocommerce_coming_soon no >/dev/null
wpw option update woocommerce_default_country "IN:KA" >/dev/null
wpw option update woocommerce_currency INR >/dev/null
wpw option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
wpw wc payment_gateway update cod --enabled=true --user=admin >/dev/null
if ! wpw wc shipping_zone_method list 0 --user=admin --format=ids | grep -q .; then
  wpw wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --user=admin >/dev/null
fi
# HPOS: stays OFF after a WP-CLI install/activation (E5 finding); real new shops get it on, so enable explicitly.
wpw wc hpos status 2>/dev/null | grep -q "HPOS enabled?: yes" || wpw wc hpos enable >/dev/null
step "setup done: permalinks='$(wpw option get permalink_structure)' coming_soon=$(wpw option get woocommerce_coming_soon) cod_enabled=$(wpw wc payment_gateway get cod --field=enabled --user=admin) hpos=$(wpw wc hpos status | grep -o 'HPOS enabled?: [a-z]*')"

# least-privilege role + user (06-depth/04 §3)
wpw role exists mcp_store_agent 2>/dev/null || wpw role create mcp_store_agent "MCP Store Agent" >/dev/null
wpw cap add mcp_store_agent read read_private_products edit_products edit_published_products edit_others_products publish_products assign_product_terms read_private_shop_orders edit_shop_orders edit_others_shop_orders edit_published_shop_orders edit_private_shop_orders >/dev/null
wpw user get mcp-agent >/dev/null 2>&1 || wpw user create mcp-agent mcp-agent@store.invalid --role=mcp_store_agent --user_pass="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >/dev/null

# WC key from env (06-depth/04 §1.3); also a read-only key for the scope test
cat > /tmp/create-key.php <<'PHP'
<?php
global $wpdb;
foreach ([[getenv('MCP_WC_CK'), getenv('MCP_WC_CS'), 'read_write', 'urumi-mcp (bootstrap)'],
          ['ck_e5readonly000000000000000000000000000002', 'cs_e5readonly000000000000000000000000000002', 'read', 'urumi-mcp (read-only test)']] as [$ck, $cs, $perm, $desc]) {
  $user = get_user_by('login', getenv('MCP_WC_USER'));
  $hash = hash_hmac('sha256', $ck, 'wc-api');
  $table = $wpdb->prefix . 'woocommerce_api_keys';
  if (!$wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key=%s", $hash))) {
    $wpdb->insert($table, ['user_id' => $user->ID, 'description' => $desc, 'permissions' => $perm,
      'consumer_key' => $hash, 'consumer_secret' => $cs, 'truncated_key' => substr($ck, -7)]);
    echo "inserted $perm key for user {$user->ID}\n";
  } else { echo "$perm key exists\n"; }
}
PHP
chmod 644 /tmp/create-key.php
su -s /bin/bash www-data -c "cd /var/www/html && MCP_WC_CK=$MCP_WC_CK MCP_WC_CS=$MCP_WC_CS MCP_WC_USER=$MCP_WC_USER wp eval-file /tmp/create-key.php"

# seed products (skip existing SKUs)
for p in "Urumi Mug|MUG-1|499" "Urumi Tee|TEE-1|899" "Urumi Cap|CAP-1|650"; do
  IFS='|' read -r name sku price <<<"$p"
  [ -n "$(wpw wc product list --sku="$sku" --user=admin --format=ids)" ] || wpw wc product create --name="$name" --sku="$sku" --regular_price="$price" --user=admin >/dev/null
done
step "products: $(wpw wc product list --user=admin --fields=id,sku,status --format=csv | tr '\n' ' ')"
step "timezone: '$(wpw option get timezone_string)' gmt_offset=$(wpw option get gmt_offset)"
step "bootstrap complete"
