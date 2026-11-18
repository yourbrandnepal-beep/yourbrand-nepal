#!/usr/bin/env bash
set -euo pipefail

# RRchat 1 Encrypted PostgreSQL Backup Script
# Streams pg_dump directly into age asymmetric encryption so no plaintext SQL touches disk.

BACKUP_DIR="/var/backups/rrchat1"
AGE_RECIPIENT_PUBKEY="${RRCHAT_BACKUP_AGE_PUBKEY:?Set RRCHAT_BACKUP_AGE_PUBKEY}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/synapse-${TIMESTAMP}.sql.gz.age"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

docker compose -f /opt/rrchat1/infra/docker-compose.yml exec -T postgres \
  pg_dump -U synapse -Fc synapse \
  | gzip -9 \
  | age -r "${AGE_RECIPIENT_PUBKEY}" -o "${OUT_FILE}"

chmod 600 "${OUT_FILE}"
echo "Encrypted backup created: ${OUT_FILE}"

# Prune backups older than 30 days
find "${BACKUP_DIR}" -name "synapse-*.sql.gz.age" -mtime +30 -delete
