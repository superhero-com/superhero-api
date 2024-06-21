import BigNumber from "bignumber.js";

export interface QuoteDto {
  convertedTo: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  total_supply: BigNumber;
  market_cap: BigNumber;
  // marketCap: number;
  timestamp: Date;
}

export interface HistoricalDataDto {
  timeOpen: Date;
  timeClose: Date;
  timeHigh: Date;
  timeLow: Date;
  quote: QuoteDto;
}
