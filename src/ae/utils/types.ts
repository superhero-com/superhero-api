import type {
  BrowserWindowMessageConnection,
  Encoded,
  Tag,
} from '@aeternity/aepp-sdk';
import {
  TX_FUNCTIONS,
  WEB_SOCKET_CHANNELS,
  WEB_SOCKET_SOURCE,
} from './constants';
import { INetworkTypes } from './networks';

/**
 * Convert `key: val` objects into union of values.
 */
export type ObjectValues<T> = T[keyof T];

export interface ITokenPrice {
  microTime: number;
  price: number;
}

export interface IToken {
  rank?: number;
  factoryAddress: Encoded.ContractAddress;
  saleAddress: Encoded.ContractAddress;

  address: Encoded.ContractAddress | string;
  decimals: number | bigint;
  name: string;
  symbol: string;

  creatorAddress: Encoded.AccountAddress;
  owner: Encoded.AccountAddress;

  beneficiary: Encoded.AccountAddress;
  bondingCurve: Encoded.ContractAddress;

  totalSupply: number;
  marketCap: number;

  aeBuyAmount: number;
  aeSellAmount: number;

  holders?: {
    account: Encoded.AccountAddress;
    balance: number;
  }[];

  metaInfo?: Record<string, string>;
}

export type CurrencyCode =
  | 'usd'
  | 'eur'
  | 'aud'
  | 'brl'
  | 'cad'
  | 'chf'
  | 'cny'
  | 'czk'
  | 'dkk'
  | 'gbp'
  | 'hkd'
  | 'huf'
  | 'idr'
  | 'ils'
  | 'inr'
  | 'jpy'
  | 'krw'
  | 'mxn'
  | 'myr'
  | 'nok'
  | 'nzd'
  | 'php'
  | 'pln'
  | 'rub'
  | 'sek'
  | 'sgd'
  | 'thb'
  | 'try'
  | 'zar'
  | 'xau';

export interface ICurrency {
  name: string;
  code: CurrencyCode;
  symbol: string;
}

export type CurrencyRates = Record<CurrencyCode, number>;

/**
 * Coins are specific to the network user can connect to. We assume each network
 * can have only one coin and many tokens.
 */
// export type ICoin = IToken & Omit<CoinGeckoMarketResponse, 'image'>;

/**
 * In general the "Asset" is any form of coin or fungible token we use in the app.
 */
// export type IAsset = ICoin | IToken;

export type TxType = 'ContractCreateTx' | 'ContractCallTx';

export interface ITopHeader {
  hash: string;
  height: number;
  pofHash: string;
  prevHash: string;
  prevKeyHash: string;
  signature: string;
  stateHash: string;
  time: number;
  txsHash: string;
  version: number;
}

export interface ITxArguments {
  type: 'tuple' | 'list' | 'int';
  value: any; // TODO find type, this was not correct: (string | number | any[])
}

/**
 * TxFunction names coming directly from the API or ready to be sent.
 */
export type TxFunctionRaw = ObjectValues<typeof TX_FUNCTIONS>;

/**
 * TxFunctions used internally by the app.
 */
export type TxFunctionParsed = keyof typeof TX_FUNCTIONS;

export type TxFunction = TxFunctionRaw | TxFunctionParsed;
export interface ITx {
  abiVersion: number;
  accountId?: Encoded.AccountAddress;
  amount: number;
  microTime: number;
  arguments: ITxArguments[];
  callData?: string; // TODO find source
  call_data?: string; // TODO incoming data is parsed with the use of camelcaseDeep, but not always
  callerId: Encoded.AccountAddress;
  code: string;
  commitmentId: any;
  contractId: Encoded.ContractAddress;
  fee: number;
  function?: TxFunction;
  gaId?: string; // Generalized Account ID
  gas: number;
  gasPrice: number;
  gasUsed: number;
  log?: any[]; // TODO find source
  decodedData?: any[]; // TODO find source
  name: any;
  nameFee: number;
  nameId: any;
  nameSalt: string;
  nonce: number;
  payerId?: string;
  payload?: string;
  pointers: any;
  result: string;
  return: ITxArguments;
  returnType: string;
  recipientId?: string;
  senderId?: string;
  selectedTokenContractId?: string;
  tag?: Tag; // Allows to establish the transaction type
  type: TxType; // Custom property we add after unpacking the Tx
  tx?: {
    signatures: string[];
    tx: ITx;
  };
  VSN: string;
}

export interface ITransaction {
  blockHeight: number;
  claim: any; // TODO find type
  hash: Encoded.TxHash;
  incomplete?: boolean;
  microIndex: number;
  microTime: number;
  pending: boolean; // There are cases that not only the IPendingTransaction can be pending
  rawTx?: any; // TODO find type
  tipUrl?: string;
  transactionOwner?: Encoded.AccountAddress;
  tx: ITx;
  url?: string;
}

export type WebSocketChannelName = ObjectValues<typeof WEB_SOCKET_CHANNELS>;
export type WebSocketSourceName = ObjectValues<typeof WEB_SOCKET_SOURCE>;

// https://github.com/aeternity/ae_mdw#websocket-interface
export interface IMiddlewareWebSocketSubscriptionMessage {
  op: 'Subscribe' | 'Unsubscribe';
  payload: WebSocketChannelName;
  target?: string;
  source?: WebSocketSourceName;
}

export enum BONDING_CURVE {
  LINEAR,
  STEPPED,
}

export type BondingCurveLinearState = {
  alpha: number;
  init_buy_price: number;
  init_sell_price: number;
};

export type SteppedBounds = {
  lower: number;
  upper: number;
  price: number;
}[];

export type BondingCurveSteppedState = {
  stepped_bounds: SteppedBounds;
  supported_decimals: number;
  sell_return_percentage: number;
  price_denominator: number;
};

export interface Wallet {
  info: {
    id: string;
    type: string;
    origin: string;
  };
  getConnection: () => BrowserWindowMessageConnection;
}

export interface Wallets {
  [key: string]: Wallet;
}

export type ICommunityFactorySchema = {
  address: Encoded.ContractAddress;
  collections: {
    [key: `${string}-${Encoded.AccountAddress}`]: {
      id: `${string}-${Encoded.AccountAddress}`;
      name: string;
      description?: string;
      allowed_name_length: string;
      allowed_name_chars: {
        [key: string]: number[];
      }[];
    };
  };
};
