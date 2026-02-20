#!/bin/bash
set -euo pipefail

BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

# Writes a single backup to the given filename. Exits non-zero on failure so
# the caller can clean up the partial file.
run_backup() {
	local filename="$1"

	echo "[pg-backup] Starting backup: ${filename}"
	pg_dump | gzip >"${filename}"
	echo "[pg-backup] Backup complete: ${filename}"
}

attempt_backup() {
	local timestamp
	timestamp=$(date -u +"%Y-%m-%dT%H-%M-%S")
	local filename="/backups/stavrobot-${timestamp}.sql.gz"

	if ! run_backup "${filename}"; then
		echo "[pg-backup] ERROR: Backup failed; removing partial file if present"
		rm -f "${filename}"
	fi

	echo "[pg-backup] Pruning backups older than ${BACKUP_RETENTION_DAYS} days"
	if ! find /backups -maxdepth 1 -name "stavrobot-*.sql.gz" -mtime "+${BACKUP_RETENTION_DAYS}" -delete; then
		echo "[pg-backup] WARNING: Pruning failed"
	fi
	echo "[pg-backup] Pruning complete"
}

attempt_backup

while true; do
	sleep "${BACKUP_INTERVAL_SECONDS}"
	attempt_backup
done
