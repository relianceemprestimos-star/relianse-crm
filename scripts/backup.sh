#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BACKUP_ROOT="${BACKUP_DIR:-$ROOT_DIR/backups/relianse-crm}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
ARCHIVE="$BACKUP_ROOT/relianse-crm-backup-$STAMP.tar.gz"

mkdir -p "$BACKUP_ROOT"

ARCHIVE_ITEMS=""

append_if_exists() {
  if [ -e "$ROOT_DIR/$1" ]; then
    ARCHIVE_ITEMS="$ARCHIVE_ITEMS $1"
  fi
}

append_if_exists data
append_if_exists uploads
append_if_exists logs
append_if_exists backend/data

if [ -z "$ARCHIVE_ITEMS" ]; then
  echo "Nenhum diretório de dados encontrado para backup." >&2
  exit 1
fi

# shellcheck disable=SC2086
tar -czf "$ARCHIVE" -C "$ROOT_DIR" $ARCHIVE_ITEMS

echo "$ARCHIVE"
