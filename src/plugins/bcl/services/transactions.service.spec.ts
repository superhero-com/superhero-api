import { TransactionDataService } from './transaction-data.service';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let communityFactoryService: {
    loadFactory: jest.Mock;
    getCurrentFactory: jest.Mock;
  };
  let transactionDataService: TransactionDataService;

  beforeEach(() => {
    communityFactoryService = {
      loadFactory: jest.fn(),
      getCurrentFactory: jest.fn().mockResolvedValue({
        bctsl_aex9_address:
          'ct_dsa6octVEHPcm7wRszK6VAjPp1FTqMWa7sBFdxQ9jBT35j6VW',
      }),
    };

    service = new TransactionsService(communityFactoryService as any);
    transactionDataService = new TransactionDataService({} as any);
  });

  it('does not emit warn logs for successful ABI decode', async () => {
    communityFactoryService.loadFactory.mockResolvedValue({
      contract: {
        $decodeEvents: jest.fn().mockReturnValue([{ name: 'Buy', args: [] }]),
      },
    });
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    const tx = {
      hash: 'th_success',
      function: 'buy',
      raw: {
        log: [],
      },
    };

    const decodedTx = await service.decodeTxEvents(
      {
        factory_address:
          'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN',
      } as any,
      tx as any,
    );

    expect(decodedTx.raw.decodedData).toEqual([{ name: 'Buy', args: [] }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to raw logs when ABI decode returns no events for buys', async () => {
    communityFactoryService.loadFactory.mockResolvedValue({
      contract: {
        $decodeEvents: jest.fn().mockReturnValue([]),
      },
    });

    const tx = {
      hash: 'th_StT3hxQqy9rZ95mF8gHF6AR2jb8wPSeacGUhxNjR3gQnE7Ezd',
      function: 'buy',
      raw: {
        amount: '2623465671425593454831',
        arguments: [{ type: 'int', value: '11962663847953000000000000' }],
        log: [
          {
            address: 'ct_2PSxfHMJPu7nC96MFvTxNcvL8VUHUNrwmVHbhUSZEd2fHDQnaC',
            data: 'cb_Xfbg4g==',
            topics: [
              '103347481884921461187458933603797704361973189016747204637339841427224784760666',
              '2547054049927760635758',
              '12671910696158013113',
              '13166240847953000000000000',
            ],
          },
          {
            address: 'ct_2PSxfHMJPu7nC96MFvTxNcvL8VUHUNrwmVHbhUSZEd2fHDQnaC',
            data: 'cb_Xfbg4g==',
            topics: [
              '3577134775049335318224940963029268892731434609492265317583808375263764302639',
              '141527277303427',
              '287210567725881',
            ],
          },
          {
            address: 'ct_dsa6octVEHPcm7wRszK6VAjPp1FTqMWa7sBFdxQ9jBT35j6VW',
            data: 'cb_Xfbg4g==',
            topics: [
              '97248968993606906149864095761415446114204891017168990930824289305879066770211',
              '62274273514407866581359016496471110071600747740718449802569890059679298943010',
              '2547054049927760635758000',
            ],
          },
        ],
      },
    };

    const decodedTx = await service.decodeTxEvents(
      {
        factory_address:
          'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN',
      } as any,
      tx as any,
    );

    expect(decodedTx.raw.decodedData).toEqual([
      {
        name: 'Mint',
        args: [null, '2547054049927760635758000'],
      },
      {
        name: 'Buy',
        args: ['2623465671425593454831', null, '13166240847953000000000000'],
      },
      {
        name: 'PriceChange',
        args: ['141527277303427', '287210567725881'],
      },
      {
        name: 'Mint',
        args: [null, '11962663847953000000000000'],
      },
    ]);

    const parsed = await service.parseTransactionData(decodedTx as any);

    expect(parsed.amount.toFixed()).toBe('2623.465671425593454831');
    expect(parsed.volume.toFixed()).toBe('11962663.847953');
    expect(parsed.protocol_reward.toFixed()).toBe('2547054.049927760635758');
    expect(parsed.total_supply.toFixed()).toBe('25128904.695906');
    expect(parsed._should_revalidate).toBe(false);
  });

  it('uses the create_community volume argument when falling back to raw logs', async () => {
    communityFactoryService.loadFactory.mockResolvedValue({
      contract: {
        $decodeEvents: jest.fn().mockReturnValue([]),
      },
    });

    const tx = {
      hash: 'th_2Wp678yXUxBtiUQ7SRfvvkd3yNYUXtVAQXEyHGZCDK1aBopRxZ',
      function: 'create_community',
      raw: {
        amount: '20435672688958921095',
        arguments: [
          {
            type: 'string',
            value:
              'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi',
          },
          { type: 'string', value: 'CUL' },
          { type: 'int', value: '2000000000000000000000000' },
          { type: 'bool', value: 'false' },
        ],
        log: [
          {
            address: 'ct_2FzqtdTssfSYVN4WFrdjit8njxtCba64b3sFfWpUsr1WMdz6U8',
            data: 'cb_Xfbg4g==',
            topics: [
              '103347481884921461187458933603797704361973189016747204637339841427224784760666',
              '20435672688958921094',
              '101670013377905080',
              '0',
            ],
          },
          {
            address: 'ct_2FzqtdTssfSYVN4WFrdjit8njxtCba64b3sFfWpUsr1WMdz6U8',
            data: 'cb_Xfbg4g==',
            topics: [
              '3577134775049335318224940963029268892731434609492265317583808375263764302639',
              '100505025000',
              '20402851853400',
            ],
          },
          {
            address: 'ct_dsa6octVEHPcm7wRszK6VAjPp1FTqMWa7sBFdxQ9jBT35j6VW',
            data: 'cb_Xfbg4g==',
            topics: [
              '97248968993606906149864095761415446114204891017168990930824289305879066770211',
              '80312013594164769264120756358055193555677206128650035100169925170029428843041',
              '20435672688958921094000',
            ],
          },
        ],
      },
    };

    const decodedTx = await service.decodeTxEvents(
      {
        factory_address:
          'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN',
      } as any,
      tx as any,
    );

    expect(decodedTx.raw.decodedData).toEqual([
      {
        name: 'Mint',
        args: [null, '20435672688958921094000'],
      },
      {
        name: 'Buy',
        args: ['20435672688958921095', null, '0'],
      },
      {
        name: 'PriceChange',
        args: ['100505025000', '20402851853400'],
      },
      {
        name: 'Mint',
        args: [null, '2000000000000000000000000'],
      },
    ]);

    const parsed = await service.parseTransactionData(decodedTx as any);

    expect(parsed.amount.toFixed()).toBe('20.435672688958921095');
    expect(parsed.volume.toFixed()).toBe('2000000');
    expect(parsed.protocol_reward.toFixed()).toBe('20435.672688958921094');
    expect(parsed.total_supply.toFixed()).toBe('2000000');
    expect(parsed._should_revalidate).toBe(false);
  });

  it('falls back to raw logs for sells', async () => {
    communityFactoryService.loadFactory.mockResolvedValue({
      contract: {
        $decodeEvents: jest.fn().mockReturnValue([]),
      },
    });

    const tx = {
      hash: 'th_ujHbruw3cubxBnN6YGBfubYA4hxcoebiJhBbXTzaRgpg4HkAu',
      function: 'sell',
      raw: {
        amount: '0',
        arguments: [
          { type: 'int', value: '9931000000000000000000' },
          { type: 'int', value: '113462332299144456' },
        ],
        log: [
          {
            address: 'ct_2PSxfHMJPu7nC96MFvTxNcvL8VUHUNrwmVHbhUSZEd2fHDQnaC',
            data: 'cb_Xfbg4g==',
            topics: [
              '23104635772480053538972224151762463181492989144154121566848232077119925570281',
              '117828884240788643',
              '1180467000000000000000000',
            ],
          },
          {
            address: 'ct_2PSxfHMJPu7nC96MFvTxNcvL8VUHUNrwmVHbhUSZEd2fHDQnaC',
            data: 'cb_Xfbg4g==',
            topics: [
              '3577134775049335318224940963029268892731434609492265317583808375263764302639',
              '12034498276971',
              '11933511576180',
            ],
          },
          {
            address: 'ct_2b8TF9TUEdqx2nV835oy8dprG2KbYpzZHcEEbdNnFJ4AVd1Foz',
            data: 'cb_Xfbg4g==',
            topics: [
              '59519329313588602299792785325724171247065768738621522936987157301332531057158',
              '82622211548122831906544292616113760892018910604459193938150949542132764339190',
              '9931000000000000000000',
            ],
          },
        ],
      },
    };

    const decodedTx = await service.decodeTxEvents(
      {
        factory_address:
          'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN',
      } as any,
      tx as any,
    );

    expect(decodedTx.raw.decodedData).toEqual([
      {
        name: 'Sell',
        args: ['117828884240788643', '1180467000000000000000000'],
      },
      {
        name: 'Burn',
        args: [null, '9931000000000000000000'],
      },
      {
        name: 'PriceChange',
        args: ['12034498276971', '11933511576180'],
      },
    ]);

    const parsed = await service.parseTransactionData(decodedTx as any);
    const priceCalculations = transactionDataService.calculatePrices(
      decodedTx as any,
      parsed,
    );

    expect(parsed.amount.toFixed()).toBe('0.117828884240788643');
    expect(parsed.volume.toFixed()).toBe('9931');
    expect(parsed.protocol_reward.toFixed()).toBe('0');
    expect(parsed.total_supply.toFixed()).toBe('1170536');
    expect(priceCalculations._previous_buy_price.toFixed()).toBe(
      '0.000012034498276971',
    );
    expect(priceCalculations._buy_price.toFixed()).toBe('0.00001193351157618');
    expect(parsed._should_revalidate).toBe(false);
  });
});
