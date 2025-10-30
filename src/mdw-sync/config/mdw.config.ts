import { ACTIVE_NETWORK } from '@/configs';
import { registerAs } from '@nestjs/config';

export default registerAs('mdw', () => ({
  reorgDepth: parseInt(process.env.REORG_DEPTH || '100', 10),
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '3000', 10),
  pageLimit: parseInt(process.env.MDW_PAGE_LIMIT || '100', 10),
  backfillBatchBlocks: parseInt(process.env.BACKFILL_BATCH_BLOCKS || '50', 10),
  bulkModeBatchBlocks: parseInt(
    process.env.BULK_MODE_BATCH_BLOCKS || '1000',
    10,
  ),
  // Note: bulkModePageLimit is deprecated - MDW has hard limit of 100
  // Keeping for backwards compatibility but it will be capped at 100
  bulkModePageLimit: parseInt(process.env.BULK_MODE_PAGE_LIMIT || '100', 10),
  parallelWorkers: parseInt(process.env.PARALLEL_WORKERS || '6', 10),
  bulkModeThreshold: parseInt(process.env.BULK_MODE_THRESHOLD || '100', 10),
  middlewareUrl: ACTIVE_NETWORK.middlewareUrl,
}));
