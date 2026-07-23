# Partner deployment skeleton

All paths and targets here are owned only by Partner Platform.

## Host preparation

1. Clone to `/var/www/kirimkode-partner`.
2. Create `/etc/kirimkode-partner/partner.env` (mode `0600`) from `.env.example`.
3. Create `/var/log/kirimkode-partner`, `/var/run/kirimkode-partner`, and `/var/backups/kirimkode-partner`; grant only the Partner service/backup users access.
4. Install the two `deploy/nginx/*.conf` templates, provision their certificates, then run `nginx -t` before reload.
5. Start only this ecosystem entry: `pm2 start deploy/ecosystem.config.cjs --only kirimkode-partner`.

## Operations

Export `PARTNER_DATABASE_URL` with database `kirimkode_partner` and a role named `kirimkode_partner_app`, `kirimkode_partner_backup`, or `kirimkode_partner_restore`.

Release also requires `PARTNER_MIGRATION_DATABASE_URL` with the same `kirimkode_partner` database but a DDL-capable role named `kirimkode_partner_migrator` or `kirimkode_partner_owner`. The runtime app role has `CREATE` revoked, so only the `prisma migrate deploy` step switches to this migrator URL; the server keeps running as `kirimkode_partner_app`.

- Release: `node scripts/release-partner.mjs`
- Backup: `node scripts/backup-partner-db.mjs`
- Restore: `PARTNER_RESTORE_CONFIRM=kirimkode_partner node scripts/restore-partner-db.mjs /var/backups/kirimkode-partner/<partner-dump>.dump`

Backup emits a custom-format dump and manifest in the Partner-only directory. Restore verifies the database name, role namespace, artifact path, manifest, and checksum. None of these scripts accepts a PM2 process name or database name override.
