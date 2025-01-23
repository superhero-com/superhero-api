# Bonding Curve TokenSale launchpad API

## Requirements
```
node >= 18
postgres >=16
redis
```

## Installation

```bash
$ npm install
```

## Update ENV configs
```bash
$ cp .env.example .env
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```


## Token Categories Support
Define the collections you want the api to support, if not cat defined here, the API will serve all collections.
```js
// src/configs/contracts.ts
export const BCL_FACTORY: Record<INetworkTypes, ICommunityFactory> = {
  [NETWORK_ID_MAINNET]: {
    address: 'ct_..',
    collections: {},
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_..',
    collections: { 
      // 'CATEGORY-ak_..': {
      //   name: 'CATEGORY',
      //   allowed_name_length: '20',
      // },
    },
  },
};
```