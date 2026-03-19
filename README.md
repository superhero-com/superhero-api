# 🚀 Bonding Curve TokenSale Launchpad API

> Create, trade, and manage tokens on the æternity blockchain with advanced features and multi-level affiliation system.


## 📑 Table of Contents

- [Project Overview](#-project-overview)
- [Related Components](#-related-components)
- [Project Architecture](#-project-architecture)
  - [Directory Structure](#-directory-structure)
  - [Core Components](#-core-components)
  - [Data Flow](#-data-flow)
  - [API Features](#-api-features)
  - [Caching Strategy](#-caching-strategy)
- [System Requirements](#-system-requirements)
- [Quick Start with Docker](#-quick-start-with-docker)
- [Manual Installation](#-manual-installation)
- [Environment Configuration](#-environment-configuration)
- [Available Scripts](#-available-scripts)
- [Docker Services](#-docker-services)
- [Token Categories Configuration](#-token-categories-configuration)
- [Development](#-development)
- [Contributing Guide](#-contributing-guide)
- [Production Deployment](#-production-deployment)
- [Contributing](#-contributing)
- [License](#-license)

## 🎯 Project Overview

This API serves as a caching and synchronization layer for the Bonding Curve Community platform on the Aeternity blockchain. It provides real-time token data, pricing information, and transaction history while maintaining collection-specific validation rules.

### 🔗 Related Components

- [bctsl/bctsl-sdk](https://github.com/bctsl/bctsl-sdk) - SDK for interacting with the bonding curve contracts
- [bctsl/bctsl-contracts](https://github.com/bctsl/bctsl-contracts) - Smart contracts for the bonding curve token sale platform
- [bctsl/bcl](https://github.com/bctsl/bcl) - Frontend application for the Bonding Curve Community platform

### ✨ Key Features

- 🔄 **Multi-Collection Support**: Handle multiple token collections with unique naming conventions and validation rules
- ⚡ **Real-time Pricing**: Synchronize and cache token pricing from the bonding curve contracts
- 📊 **Transaction Tracking**: Monitor and validate buy/sell transactions
- 🏆 **Data Rankings**: Provide token rankings globally and per collection
- 🔔 **WebSocket Events**: Broadcast real-time updates for token prices, creation, and transactions
- 🧹 **Data Reorganization**: Automatically handle and remove invalid transactions
- 🔗 **MDW Integration**: Seamless integration with Aeternity Middleware (MDW)

## 🏗 Project Architecture

### 📁 Directory Structure

```
src/
├── ae/                    # Aeternity blockchain integration
├── ae-pricing/           # Pricing calculation and synchronization
├── configs/              # Application configuration
├── tokens/              # Token management and WebSocket events
├── transactions/        # Transaction processing and validation
└── utils/               # Utility functions and helpers
```

### 🧩 Core Components

1. 🎫 **Token Management** (`src/tokens/`)
   - Token data caching and retrieval
   - WebSocket gateway for real-time updates
   - Collection-specific validation rules
   - Token ranking calculations
   - Price history tracking

2. 💱 **Transaction Processing** (`src/transactions/`)
   - Transaction monitoring and validation
   - Buy/Sell operation tracking
   - Invalid transaction handling
   - Transaction history management

3. ⛓ **Aeternity Integration** (`src/ae/`)
   - MDW client implementation
   - Blockchain event monitoring
   - Contract interaction
   - Network synchronization

4. 💰 **Pricing Engine** (`src/ae-pricing/`)
   - Price synchronization

### 🔄 Data Flow

1. 🚦 **Initialization**
   - Load collection configurations
   - Establish MDW connection
   - Initialize WebSocket server
   - Start price synchronization

2. 🎫 **Token Operations**
   - Validate token names against collection rules
   - Calculate and cache token prices
   - Track token ownership
   - Update token rankings
   - Broadcast token events

3. 💸 **Transaction Handling**
   - Monitor blockchain for new transactions
   - Validate transaction legitimacy
   - Update token prices and ownership
   - Broadcast transaction events
   - Handle transaction reorganization

4. 🔄 **Data Synchronization**
   - Periodic price updates
   - Transaction history synchronization
   - Data cleanup and validation
   - Cache management

### 🛠 API Features

1. 🎫 **Token Endpoints**
   - Token validation
   - Price history retrieval
   - Token rankings (global/collection)

2. 💱 **Transaction Endpoints**
   - Transaction history
   - Transaction validation status

3. 🔔 **WebSocket Events**
   - Token price updates
   - New token creation
   - Transaction notifications
   - Collection updates

4. 📚 **Collection Management**
   - Collection configuration
   - Validation rules
   - Naming conventions
   - Character code restrictions

### 💾 Caching Strategy

The API implements a multi-layer caching strategy:

1. 💡 **In-Memory Cache**
   - Active token prices
   - Recent transactions
   - Validation rules

2. ⚡ **Redis Cache**
   - Token rankings
   - Price history
   - Collection statistics

3. 💽 **PostgreSQL Database**
   - Historical data
   - Transaction records
   - Token metadata
   - Collection configurations

## 🛠 System Requirements

- 📦 Node.js >= 18
- 🗄️ PostgreSQL >= 16
- 📝 Redis (latest)
- 🐳 Docker and Docker Compose (for containerized setup)

## 🚀 Quick Start with Docker

The easiest way to run the application is using Docker Compose:

```bash
# Clone the repository
git clone https://github.com/bctsl/bctsl-api.git
cd bctsl-api


# Setup environment variables
cp .env.example .env

# Start all services
docker compose up --build
```

The application will be available at `http://localhost:3000`.

## 📦 Manual Installation

If you prefer to run the services locally:

```bash
# Install dependencies
npm install

# Setup environment variables
cp .env.example .env

# Start the development server
npm run start:dev
```

## 📝 Environment Configuration

Configure the following environment variables in your `.env` file:

```bash
# Database Configuration
DB_TYPE=postgres
DB_HOST=127.0.0.1        # Use 'postgres' if running with Docker
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres     # Change in production
DB_DATABASE=bcl_api
DB_SYNC=true            # Set to false in production

# Redis Configuration
REDIS_HOST=localhost    # Use 'redis' if running with Docker
REDIS_PORT=6379

# Network Configuration
AE_NETWORK_ID=ae_mainnet  # or ae_uat for testnet

# Application Configuration
APP_PORT=3000
```

## 📊 Available Scripts

```bash
# Development
npm run start          # Start the application
npm run start:dev      # Start with hot-reload
npm run start:prod     # Start in production mode
```

## 🐳 Docker Services

The project includes three main services:

1. **API Service** (`api`):
   - NestJS application
   - Runs on port 3000
   - Auto-reloads in development

2. **PostgreSQL** (`postgres`):
   - Version 16
   - Persists data in a Docker volume
   - Accessible on port 5432

3. **Redis** (`redis`):
   - Latest Alpine version
   - Persists data in a Docker volume
   - Accessible on port 6379

## 📚 Token Categories Configuration

Define the collections you want the API to support in `src/configs/contracts.ts`:

```typescript
export const BCL_FACTORY: Record<INetworkTypes, ICommunityFactorySchema> = {
  [NETWORK_ID_MAINNET]: {
    address: 'ct_..',
    collections: {
      // Example configuration:
      // 'CATEGORY-ak_..': {
      //   name: 'CATEGORY',
      //   allowed_name_length: '20',
      //   description: 'Tokenize a unique name with up to 20 characters',  
      // },
    },
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_..',
    collections: {}
  }
};
```

## 💻 Development

For detailed information about our development standards, testing practices, and contribution guidelines, please see our [Contributing Guide](CONTRIBUTING.md).

### 🐳 Docker Commands

```bash
# Start all services
docker compose up

# Start services in background
docker compose up -d

# Stop all services
docker compose down

# View logs
docker compose logs -f

# Rebuild services
docker compose up --build
```

### 🐳 Second testnet stack (isolated DB & Redis)

To run another testnet instance in Docker with its own database and Redis (e.g. for a separate test environment):

```bash
# Optional: set env for DB credentials and ports (defaults: user testnet, DB api_testnet2, API port 3001, Postgres 5437, Redis 6380)
export TESTNET_DB_USER=testnet
export TESTNET_DB_PASSWORD=testnet
export TESTNET_DB_DATABASE=api_testnet2
export TESTNET_APP_PORT=3001
export TESTNET_DB_PORT=5437
export TESTNET_REDIS_PORT=6380

# Start the second testnet stack
docker compose -f docker-compose-testnet.yml up -d

# API: http://localhost:3001 (or TESTNET_APP_PORT)
# Stop: docker compose -f docker-compose-testnet.yml down
```

The stack uses `AE_NETWORK_ID=ae_uat`, separate volumes (`postgres_testnet2_data`, `redis_testnet2_data`), and container names `superhero-api-testnet2`, `superhero-api-testnet2-db`, `superhero-api-testnet2-redis` so it does not conflict with the default compose or another testnet deploy.

**If you run the app on the host** (`npm run start:prod`) it uses your `.env` (e.g. `DB_HOST=127.0.0.1`, `DB_PORT=5436`). That points at your local/dev DB and Redis, not the testnet containers—so you get `ECONNREFUSED` if nothing is listening on those ports. Either use the API in Docker at http://localhost:3001, or run the app on the host against the testnet DB/Redis by copying `.env.testnet.example` to `.env` (it uses `DB_PORT=5437`, `REDIS_PORT=6380` and user `testnet`/DB `api_testnet2` to match the testnet stack).

### 🗄️ Database Management

The database automatically syncs schema changes in development (`DB_SYNC=true`). For production, you should manage database migrations manually.

For the X invite and verification reward schema added in this codebase, apply `docs/profile-x-invites-manual-migration.sql` before deploying with `DB_SYNC=false`.

## 🚀 Production Deployment

For production deployment:

1. Set appropriate environment variables
2. Apply the required manual SQL migration files
3. Disable `DB_SYNC`
4. Use proper secrets management
5. Configure proper network settings
6. Enable SSL/TLS

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Development standards
- Code style and linting
- Testing requirements
- Commit message conventions
- Pull request process

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025, BCTSL