# MDW Plugin System

This guide explains how to create and register new plugins for the centralized MDW indexer.

## Overview

The MDW plugin system allows you to:
- Listen for specific types of transactions
- Process transactions in real-time
- Handle blockchain reorganizations automatically
- Store processed data with automatic cascade deletion on reorgs

## Creating a Plugin

### 1. Create Plugin Class

Create a new file `src/plugins/your-domain/your-domain.plugin.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, Transaction } from '@/mdw/plugins/mdw-plugin.interface';
import { YourEntity } from './entities/your-entity.entity';

@Injectable()
export class YourDomainPlugin implements Plugin {
  name = 'your-domain';
  private readonly logger = new Logger(YourDomainPlugin.name);

  constructor(
    @InjectRepository(YourEntity)
    private readonly yourEntityRepository: Repository<YourEntity>,
  ) {}

  startFromHeight(): number {
    // Return the block height from which this plugin should start indexing
    // This prevents re-processing old data on restart
    return 100000; // Adjust based on your contract deployment
  }

  filters() {
    return [
      {
        type: 'contract_call' as const,
        contractIds: ['ct_your_contract_address'],
        functions: ['your_function_name'],
      },
      // You can add multiple filters
      {
        type: 'spend' as const,
        predicate: (tx: Transaction) => {
          // Custom logic to filter spend transactions
          return tx.raw?.tx?.payload?.includes('YOUR_PREFIX');
        },
      },
    ];
  }

  async onTransactionsSaved(txs: Transaction[]): Promise<void> {
    for (const tx of txs) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        this.logger.error(`Failed to process transaction ${tx.tx_hash}`, error);
      }
    }
  }

  async onReorg(rollBackToHeight: number): Promise<void> {
    this.logger.log(`Your domain plugin handling reorg from height ${rollBackToHeight}`);
    // Optional: Handle reorg-specific logic
    // Most plugins don't need this as FK cascade handles cleanup
  }

  private async processTransaction(tx: Transaction): Promise<void> {
    // Your transaction processing logic here
    // Access transaction data via tx.raw
    // Store processed data in your entities
  }
}
```

### 2. Create Plugin Module

Create `src/plugins/your-domain/your-domain-plugin.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YourDomainPlugin } from './your-domain.plugin';
import { YourEntity } from './entities/your-entity.entity';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';

@Module({
  imports: [
    TypeOrmModule.forFeature([YourEntity]),
  ],
  providers: [
    {
      provide: MDW_PLUGIN,
      useClass: YourDomainPlugin,
      multi: true,
    },
  ],
  exports: [YourDomainPlugin],
})
export class YourDomainPluginModule {}
```

### 3. Add Foreign Key to Your Entities

To enable automatic cleanup on reorgs, add a foreign key to your entities:

```typescript
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Transaction } from '@/mdw/entities/mdw-tx.entity';

@Entity()
export class YourEntity {
  @Column()
  id: string;

  // Add this relationship for automatic cascade deletion
  @ManyToOne(() => Transaction, (tx) => tx.tx_hash, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'tx_hash' })
  mdwTx: Transaction;

  @Column()
  tx_hash: string;

  // ... other fields
}
```

### 4. Register Plugin Module

Add your plugin module to the main app module or a feature module:

```typescript
import { YourDomainPluginModule } from './plugins/your-domain/your-domain-plugin.module';

@Module({
  imports: [
    // ... other imports
    YourDomainPluginModule,
  ],
})
export class AppModule {}
```

## Filter Types

### Contract Call Filters
```typescript
{
  type: 'contract_call',
  contractIds: ['ct_contract1', 'ct_contract2'],
  functions: ['function1', 'function2'],
}
```

### Spend Transaction Filters
```typescript
{
  type: 'spend',
  predicate: (tx: Transaction) => {
    // Custom logic to filter spend transactions
    return tx.raw?.tx?.payload?.includes('YOUR_PREFIX');
  },
}
```

### Custom Predicate Filters
```typescript
{
  type: 'contract_call',
  contractIds: ['ct_contract'],
  predicate: (tx: Transaction) => {
    // Additional custom filtering logic
    return tx.raw?.tx?.arguments?.[0]?.value === 'specific_value';
  },
}
```

## Transaction Data Structure

The `Transaction` object contains:

```typescript
{
  tx_hash: string;           // Transaction hash
  block_height: number;      // Block height
  block_hash: string;        // Block hash
  micro_time: string;        // Timestamp as string
  type: string;              // Transaction type
  contract_id?: string;      // Contract address (for contract calls)
  function?: string;         // Function name (for contract calls)
  caller_id?: string;        // Caller address
  sender_id?: string;        // Sender address (for spend tx)
  recipient_id?: string;     // Recipient address (for spend tx)
  raw: any;                  // Full transaction data from MDW
}
```

## Best Practices

1. **Error Handling**: Always wrap transaction processing in try-catch blocks
2. **Idempotency**: Check if data already exists before creating new records
3. **Performance**: Use batch operations when processing multiple transactions
4. **Logging**: Use structured logging for debugging
5. **Foreign Keys**: Always add FK relationships to `mdw_tx` for automatic cleanup

## Monitoring

Check plugin health via the MDW health endpoint:

```bash
GET /mdw/health
```

This returns sync status for all plugins and the overall indexer state.

## Configuration

Configure the indexer via environment variables:

```bash
REORG_DEPTH=100                    # Reorg detection depth
SYNC_INTERVAL_MS=3000             # Sync interval in milliseconds
MDW_PAGE_LIMIT=100                # MDW API page limit
BACKFILL_BATCH_BLOCKS=50          # Batch size for backfill
MIDDLEWARE_URL=https://testnet.aeternity.io  # MDW URL
```
