<?php
/**
 * Plugin Name: Urumi hardening
 * Description: HTTPS redirect behind TLS and no anonymous user enumeration. Must-use plugin baked into the image.
 */
if (!defined('ABSPATH')) exit;

// A store served over HTTPS (WP_HOME https://...) redirects requests that reached the ingress over plain HTTP, so a
// wp-login.php password is never sent in clear text. Probes, wp-cli and woo-mcp (X-Forwarded-Proto: https) are
// unaffected; Traefik overwrites a client's X-Forwarded-Proto.
if (defined('WP_HOME') && strpos(WP_HOME, 'https://') === 0 && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'http') {
  header('Location: ' . WP_HOME . ($_SERVER['REQUEST_URI'] ?? '/'), true, 301);
  exit;
}

// Anonymous visitors can't list user accounts: /wp/v2/users is for logged-in users only (the block editor uses it)...
add_filter('rest_endpoints', function ($endpoints) {
  if (!is_user_logged_in()) {
    foreach (array_keys($endpoints) as $route) {
      if (strpos($route, '/wp/v2/users') === 0) unset($endpoints[$route]);
    }
  }
  return $endpoints;
});
// ...and ?author=N / author archives don't reveal login names (priority 1: before redirect_canonical, which would
// answer ?author=1 with a redirect to /author/<login>/).
add_action('template_redirect', function () {
  if (is_author() || isset($_GET['author'])) {
    wp_safe_redirect(home_url('/'), 301);
    exit;
  }
}, 1);
