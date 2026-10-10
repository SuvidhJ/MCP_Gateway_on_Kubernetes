#!/usr/bin/env bash
# Download the pinned WooCommerce zip and wp-cli phar for images/wordpress and verify them against the recorded
# images/wordpress/SHA256SUMS (wp-cli is also checked against its published .sha512). Skips files already present.
set -euo pipefail
cd "$(dirname "$0")/../images/wordpress"
mkdir -p downloads && cd downloads
[ -f woocommerce.11.2.0.zip ] || curl -fsSL -o woocommerce.11.2.0.zip https://downloads.wordpress.org/plugin/woocommerce.11.2.0.zip
if [ ! -f wp-cli-2.12.0.phar ]; then
  curl -fsSL -o wp-cli-2.12.0.phar https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar
  echo "$(curl -fsSL https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar.sha512)  wp-cli-2.12.0.phar" | sha512sum -c -
fi
sha256sum -c ../SHA256SUMS
