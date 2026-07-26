# Partner deployment skeleton

All paths and targets here are owned only by Partner Platform.

## Host preparation

1. Clone to `/var/www/kirimkode-partner`.
2. Create `/etc/kirimkode-partner/partner.env` (mode `0600`) from `.env.example`.
3. Create `/var/log/kirimkode-partner`, `/var/run/kirimkode-partner`, and `/var/backups/kirimkode-partner`; grant only the Partner service/backup users access.
4. Install the two `deploy/nginx/*.conf` templates, provision their certificates, then run `nginx -t` before reload.
5. Start only this ecosystem entry: `pm2 start deploy/ecosystem.config.cjs --only kirimkode-partner`.

## Background jobs — register the scheduler

**Not optional.** Seven jobs carry the platform's money and hygiene
(`offline-sweep`, `reservation-recovery`, `order-timeout`,
`order-completion-sweep`, `earning-release`, `retention-redaction`,
`reconcile`). Nothing in the app invokes them: `POST /api/cron/v1?job=<name>` is
driven from outside. With no scheduler the server looks perfectly healthy while
expired holds are never released and **earnings never become available, so
partners cannot cash out at all**.

Register exactly ONE minutely entry — `scripts/run-cron.mjs` decides which jobs
are due from `scripts/lib/cron-schedule.mjs`, so per-job cadence stays in version
control rather than in an operator's crontab:

```
# /etc/systemd/system/partner-cron.service
[Unit]
Description=KirimKode Partner cron tick
After=network-online.target
[Service]
Type=oneshot
WorkingDirectory=/var/www/kirimkode-partner
ExecStart=/usr/bin/node scripts/run-cron.mjs
EnvironmentFile=/etc/kirimkode-partner/partner.env

# /etc/systemd/system/partner-cron.timer
[Unit]
Description=Run the KirimKode Partner cron tick every minute
[Timer]
OnCalendar=minutely
AccuracySec=5s
Persistent=false
[Install]
WantedBy=timers.target
```

`systemctl enable --now partner-cron.timer`. The full crontab and Windows
variants are in the footer comment of `scripts/run-cron.mjs`.

The tick reaches the app over loopback, where it declares the already-terminated
`https` scheme so the dispatch route accepts it. Pointed at a remote `http://`
origin it refuses to run rather than ship `PARTNER_CRON_SECRET` in clear text, so
leave `PARTNER_CRON_BASE_URL` unset (defaults to `http://127.0.0.1:3001`) unless
the scheduler runs off-host over TLS.

Verify after every release, before considering the deploy done:

```
node scripts/run-cron.mjs --dry-run     # plan only, calls nothing
curl -sS -H "authorization: Bearer $PARTNER_CRON_SECRET" \
  http://127.0.0.1:3001/api/health/cron
```

`/api/health/cron` reports `degraded` with HTTP 503 while any job has not been
seen inside its cadence, and `healthy` with 200 once every job has ticked — alert
on the status alone. Right after enabling the timer, expect `degraded` until one
tick of each cadence has passed (the slowest is hourly).

## Operations

Export `PARTNER_DATABASE_URL` with database `kirimkode_partner` and a role named `kirimkode_partner_app`, `kirimkode_partner_backup`, or `kirimkode_partner_restore`.

Release also requires `PARTNER_MIGRATION_DATABASE_URL` with the same `kirimkode_partner` database but a DDL-capable role named `kirimkode_partner_migrator` or `kirimkode_partner_owner`. The runtime app role has `CREATE` revoked, so only the `prisma migrate deploy` step switches to this migrator URL; the server keeps running as `kirimkode_partner_app`.

- Release: `node scripts/release-partner.mjs`
- Backup: `node scripts/backup-partner-db.mjs`
- Restore: `PARTNER_RESTORE_CONFIRM=kirimkode_partner node scripts/restore-partner-db.mjs /var/backups/kirimkode-partner/<partner-dump>.dump`

Backup emits a custom-format dump and manifest in the Partner-only directory. Restore verifies the database name, role namespace, artifact path, manifest, and checksum. None of these scripts accepts a PM2 process name or database name override.
