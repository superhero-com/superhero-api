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
```js
// src/configs/contracts.ts
export const BCL_FACTORY: Record<INetworkTypes, IFactorySchema> = {
  [NETWORK_ID_MAINNET]: {
    address: 'ct_..',
    categories: {},
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_..',
    /**
     * Define the categories you want the api to support, if not cat defined here, the API will serve all categories.
     */
    categories: { 
      // 'CATEGORY-ak_..': {
      //   name: 'CATEGORY',
      //   allowed_name_length: '20',
      // },
    },
  },
};
```