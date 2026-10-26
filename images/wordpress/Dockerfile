# Immutable store image: WordPress + pinned WooCommerce + wp-cli. Code is root-owned and served straight from
# /usr/src/wordpress (no copy into /var/www/html at start), so the pod runs as www-data (uid 33) on port 8080 with a
# read-only root filesystem; only wp-content/uploads (a PVC) and a few run/tmp dirs (emptyDirs) are writable.
# The bootstrap Job runs this same image with `command: [/usr/local/bin/urumi-bootstrap]`.
# Inputs (gitignored, fetched + checksum-verified by scripts/fetch-store-assets.sh): downloads/woocommerce.11.2.0.zip,
# downloads/wp-cli-2.12.0.phar.
FROM wordpress:7.1.3-php8.4-apache
COPY downloads/wp-cli-2.12.0.phar /usr/local/bin/wp
COPY downloads/woocommerce.11.2.0.zip /tmp/woocommerce.zip
COPY htaccess /usr/src/wordpress/.htaccess
COPY apache-urumi.conf /etc/apache2/conf-available/urumi.conf
COPY urumi-hardening.php /usr/src/wordpress/wp-content/mu-plugins/urumi-hardening.php
RUN set -eux; \
    php -r '$z=new ZipArchive; if ($z->open("/tmp/woocommerce.zip")!==true) exit(1); $z->extractTo("/usr/src/wordpress/wp-content/plugins/"); $z->close();'; \
    rm /tmp/woocommerce.zip; \
    chmod 0755 /usr/local/bin/wp; \
    cp /usr/src/wordpress/wp-config-docker.php /usr/src/wordpress/wp-config.php; \
    mkdir -p /usr/src/wordpress/wp-content/uploads; \
    chown -R root:root /usr/src/wordpress; \
    chown www-data:www-data /usr/src/wordpress/wp-content/uploads; \
    sed -i 's/^Listen 80$/Listen 8080/; s/^\(\s*\)Listen 443$/\1Listen 8443/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/; s#DocumentRoot /var/www/html#DocumentRoot /usr/src/wordpress#' /etc/apache2/sites-available/000-default.conf; \
    a2enconf urumi; \
    grep -q '^Listen 8080' /etc/apache2/ports.conf; \
    grep -q 'VirtualHost \*:8080' /etc/apache2/sites-available/000-default.conf
COPY php-urumi.ini /usr/local/etc/php/conf.d/zz-urumi.ini
COPY mpm_prefork.conf /etc/apache2/mods-available/mpm_prefork.conf
COPY --chmod=0755 bootstrap.sh /usr/local/bin/urumi-bootstrap
WORKDIR /usr/src/wordpress
USER 33:33
EXPOSE 8080
# No docker-entrypoint.sh: it would copy the code into /var/www/html. wp-config.php reads WORDPRESS_* env at runtime.
ENTRYPOINT []
CMD ["apache2-foreground"]
