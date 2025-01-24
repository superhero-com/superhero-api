# Bonding Curve TokenSale Launchpad API

## Project Overview

This API serves as a caching and synchronization layer for the Bonding Curve Community platform on the Aeternity blockchain. It provides real-time token data, pricing information, and transaction history while maintaining collection-specific validation rules.

### Key Features

- **Multi-Collection Support**: Handle multiple token collections with unique naming conventions and validation rules
- **Real-time Pricing**: Synchronize and cache token pricing from the bonding curve contracts
- **Transaction Tracking**: Monitor and validate buy/sell transactions
- **Data Rankings**: Provide token rankings globally and per collection
- **WebSocket Events**: Broadcast real-time updates for token prices, creation, and transactions
- **Data Reorganization**: Automatically handle and remove invalid transactions
- **MDW Integration**: Seamless integration with Aeternity Middleware (MDW)

## Project Architecture

### Directory Structure

```
src/
├── ae/                    # Aeternity blockchain integration
├── ae-pricing/           # Pricing calculation and synchronization
├── configs/              # Application configuration
├── tokens/              # Token management and WebSocket events
├── transactions/        # Transaction processing and validation
└── utils/               # Utility functions and helpers
```

### Core Components

1. **Token Management** (`src/tokens/`)
   - Token data caching and retrieval
   - WebSocket gateway for real-time updates
   - Collection-specific validation rules
   - Token ranking calculations
   - Price history tracking

2. **Transaction Processing** (`src/transactions/`)
   - Transaction monitoring and validation
   - Buy/Sell operation tracking
   - Invalid transaction handling
   - Transaction history management

3. **Aeternity Integration** (`src/ae/`)
   - MDW client implementation
   - Blockchain event monitoring
   - Contract interaction
   - Network synchronization

4. **Pricing Engine** (`src/ae-pricing/`)
   - Price synchronization

### Data Flow

1. **Initialization**
   - Load collection configurations
   - Establish MDW connection
   - Initialize WebSocket server
   - Start price synchronization

2. **Token Operations**
   - Validate token names against collection rules
   - Calculate and cache token prices
   - Track token ownership
   - Update token rankings
   - Broadcast token events

3. **Transaction Handling**
   - Monitor blockchain for new transactions
   - Validate transaction legitimacy
   - Update token prices and ownership
   - Broadcast transaction events
   - Handle transaction reorganization

4. **Data Synchronization**
   - Periodic price updates
   - Transaction history synchronization
   - Data cleanup and validation
   - Cache management

### API Features

1. **Token Endpoints**
   - Token validation
   - Price history retrieval
   - Token rankings (global/collection)

2. **Transaction Endpoints**
   - Transaction history
   - Transaction validation status

3. **WebSocket Events**
   - Token price updates
   - New token creation
   - Transaction notifications
   - Collection updates

4. **Collection Management**
   - Collection configuration
   - Validation rules
   - Naming conventions
   - Character code restrictions

### Caching Strategy

The API implements a multi-layer caching strategy:

1. **In-Memory Cache**
   - Active token prices
   - Recent transactions
   - Validation rules

2. **Redis Cache**
   - Token rankings
   - Price history
   - Collection statistics

3. **PostgreSQL Database**
   - Historical data
   - Transaction records
   - Token metadata
   - Collection configurations

## System Requirements

- Node.js >= 18
- PostgreSQL >= 16
- Redis (latest)
- Docker and Docker Compose (for containerized setup)

## Quick Start with Docker

The easiest way to run the application is using Docker Compose:

```bash
# Clone the repository
git clone [repository-url]
cd tokaen-api

# Setup environment variables
cp .env.example .env

# Start all services
docker compose up --build
```

The application will be available at `http://localhost:3000`.

## Manual Installation

If you prefer to run the services locally:

```bash
# Install dependencies
npm install

# Setup environment variables
cp .env.example .env

# Start the development server
npm run start:dev
```

## Environment Configuration

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

## Available Scripts

```bash
# Development
npm run start          # Start the application
npm run start:dev      # Start with hot-reload
npm run start:prod     # Start in production mode
```

## Docker Services

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

## Token Categories Configuration

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

## Development

### Docker Commands

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

### Database Management

The database automatically syncs schema changes in development (`DB_SYNC=true`). For production, you should manage database migrations manually.

## Production Deployment

For production deployment:

1. Set appropriate environment variables
2. Disable `DB_SYNC`
3. Use proper secrets management
4. Configure proper network settings
5. Enable SSL/TLS

## Contributing

Please refer to our contribution guidelines for details on our code of conduct and the process for submitting pull requests.