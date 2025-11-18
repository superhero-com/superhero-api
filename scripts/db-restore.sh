#!/bin/bash

# === CONFIG ===
DB_NAME="api"
DB_USER="pguser"
DB_PASSWORD="postgres"
DB_PORT="5436"
DB_HOST="localhost"
BACKUP_FILE="scripts/latest.sql.gz"
CONTAINER_NAME=$(docker-compose -f docker-compose-dev.yml ps -q postgres)

# === CHECK BACKUP ===
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Backup file $BACKUP_FILE not found!"
  exit 1
fi

# === EXPORT PGPASSWORD ===
export PGPASSWORD=$DB_PASSWORD

# === COPY BACKUP TO CONTAINER ===
echo "📦 Copying backup to container..."
docker cp $BACKUP_FILE $CONTAINER_NAME:/tmp/latest.sql.gz

# === EXECUTE IMPORT ===
echo "🗄️  Importing backup into database '$DB_NAME'..."
docker exec -i $CONTAINER_NAME bash -c "gunzip -c /tmp/latest.sql.gz | psql -U $DB_USER -d $DB_NAME"

# === CLEANUP ===
echo "🧹 Cleaning up..."
docker exec -i $CONTAINER_NAME rm /tmp/latest.sql.gz

echo "✅ Done! Database '$DB_NAME' restored."
