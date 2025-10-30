import { ACTIVE_NETWORK } from '@/configs';
import { registerAs } from '@nestjs/config';

export default registerAs('mdw', () => ({
  reorgDepth: parseInt(process.env.REORG_DEPTH || '100', 10),
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '3000', 10),
  pageLimit: parseInt(process.env.MDW_PAGE_LIMIT || '100', 10),
  backfillBatchBlocks: parseInt(process.env.BACKFILL_BATCH_BLOCKS || '50', 10),
  middlewareUrl: ACTIVE_NETWORK.middlewareUrl,
}));
