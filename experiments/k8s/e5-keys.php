<?php
// E5 diagnostics: dump WC API key rows and the agent user's caps. Run: wp eval-file - < k8s/e5-keys.php
global $wpdb;
foreach ($wpdb->get_results("SELECT key_id,user_id,permissions,truncated_key,consumer_key,consumer_secret,description FROM {$wpdb->prefix}woocommerce_api_keys") as $r)
  printf("key %d user %d %-10s trunc=%-8s ck=%s... cs=%s... %s\n", $r->key_id, $r->user_id, $r->permissions, $r->truncated_key, substr($r->consumer_key, 0, 12), substr($r->consumer_secret, 0, 10), $r->description);
printf("expected RW ck hash: %s...\nhmac(empty):         %s...\n", substr(hash_hmac('sha256', 'ck_e5spike0000000000000000000000000000000001', 'wc-api'), 0, 12), substr(hash_hmac('sha256', '', 'wc-api'), 0, 12));
$u = get_user_by('login', 'mcp-agent');
printf("mcp-agent id=%d roles=%s can(read_private_products)=%d can(publish_products)=%d can(read_private_shop_orders)=%d\n", $u->ID, implode(',', $u->roles), user_can($u, 'read_private_products'), user_can($u, 'publish_products'), user_can($u, 'read_private_shop_orders'));
printf("hpos option=%s  coming_soon=%s  timezone='%s'\n", get_option('woocommerce_custom_orders_table_enabled'), get_option('woocommerce_coming_soon'), get_option('timezone_string'));
