# Immutable store image: WordPress + pinned WooCommerce + wp-cli, all files owned by www-data (uid 33).
# The bootstrap Job runs this same image with `command: [/usr/local/bin/urumi-bootstrap]`.
# Inputs (gitignored, fetched + checksum-verified by scripts/fetch-store-assets.sh): downloads/woocommerce.11.2.0.zip,
# downloads/wp-cli-2.12.0.phar.
FROM wordpress:7.1.3-php8.4-apache
COPY downloads/wp-cli-2.12.0.phar /usr/local/bin/wp
COPY downloads/woocommerce.11.2.0.zip /tmp/woocommerce.zip
RUN set -eux; \
    php -r '$z=new ZipArchive; if ($z->open("/tmp/woocommerce.zip")!==true) exit(1); $z->extractTo("/usr/src/wordpress/wp-content/plugins/"); $z->close();'; \
    rm /tmp/woocommerce.zip; \
    chmod 0755 /usr/local/bin/wp; \
    cp /usr/src/wordpress/wp-config-docker.php /usr/src/wordpress/wp-config.php; \
    chown -R www-data:www-data /usr/src/wordpress
COPY php-urumi.ini /usr/local/etc/php/conf.d/zz-urumi.ini
COPY mpm_prefork.conf /etc/apache2/mods-available/mpm_prefork.conf
COPY --chmod=0755 bootstrap.sh /usr/local/bin/urumi-bootstrap
