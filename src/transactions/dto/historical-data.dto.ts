import BigNumber from 'bignumber.js';

export interface QuoteDto {
  convertedTo: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // null for DEX pairs: LP total supply and per-token market cap are not tracked
  // by the sync layer, so we return null rather than a fabricated value.
  total_supply: BigNumber | null;
  market_cap: BigNumber | null;
  // marketCap: number;
  timestamp: Date;
  symbol: string;
}

export interface HistoricalDataDto {
  timeOpen: Date;
  timeClose: Date;
  timeHigh: Date;
  timeLow: Date;
  quote: QuoteDto;
}
