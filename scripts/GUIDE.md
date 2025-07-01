# Developer Guide

## Database Restoration

This guide will help you restore the database from a backup file for local development.

### Prerequisites

- Docker and Docker Compose installed
- Access to the development server
- Backup file (`latest.sql.gz`) from the dev server

### Step 1: Download the Backup File

Download the latest database backup from the development server:

```bash
# Replace with your actual dev server details
scp root@dev.wordcraft.fun:/root/db-backups/mainnet/latest.sql.gz ./
```

Or download it through your preferred method (SFTP, web interface, etc.) and place it in the project root directory.

### Step 2: Start the Development Environment

Start the PostgreSQL and Redis services using Docker Compose:

```bash
# From the project root directory
docker-compose -f docker-compose-dev.yml up -d
```

This will start:
- PostgreSQL on port `5436`
- Redis on port `6379`

### Step 3: Verify Services are Running

Check that the containers are running properly:

```bash
docker-compose -f docker-compose-dev.yml ps
```

You should see both `postgres` and `redis` services in the "Up" state.

### Step 4: Restore the Database

Run the database restore script:

```bash
# From the project root directory
./scripts/db-restore.sh
```

The script will:
1. Check if the backup file exists
2. Copy the backup to the PostgreSQL container
3. Import the data into the database
4. Clean up temporary files

### Step 5: Verify the Restoration

You can verify the restoration was successful by connecting to the database:

```bash
# Connect to PostgreSQL
docker exec -it $(docker-compose -f docker-compose-dev.yml ps -q postgres) psql -U pguser -d api

# List tables to verify data
\dt

# Exit PostgreSQL
\q
```

### Troubleshooting

#### Backup File Not Found
If you get an error about the backup file not being found:
- Ensure `latest.sql.gz` is in the project root directory
- Check the file permissions
- Verify the file is not corrupted

#### Container Issues
If containers fail to start:
```bash
# Stop and remove containers
docker-compose -f docker-compose-dev.yml down

# Remove volumes (WARNING: This will delete all local data)
docker-compose -f docker-compose-dev.yml down -v

# Start fresh
docker-compose -f docker-compose-dev.yml up -d
```

#### Permission Issues
If the restore script fails due to permissions:
```bash
# Make the script executable
chmod +x scripts/db-restore.sh
```

### Database Configuration

The development database uses these default settings:
- **Database Name**: `api`
- **Username**: `pguser`
- **Password**: `postgres`
- **Host**: `localhost`
- **Port**: `5436`

### Stopping the Environment

When you're done developing:

```bash
# Stop the services
docker-compose -f docker-compose-dev.yml down

# To also remove volumes (WARNING: This will delete all local data)
docker-compose -f docker-compose-dev.yml down -v
```

### Notes

- The backup file should be named `latest.sql.gz` and placed in the project root
- The restore script will automatically handle the database creation and data import
- Make sure you have sufficient disk space for the database backup
- The restoration process may take several minutes depending on the backup size
