import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DexTokensController } from './dex-tokens.controller';

describe('DexTokensController', () => {
  let controller: DexTokensController;
  let dexTokenService: {
    findAll: jest.Mock;
    findByAddress: jest.Mock;
    getTokenPrice: jest.Mock;
    getTokenPriceWithLiquidityAnalysis: jest.Mock;
    findBestPairForToken: jest.Mock;
    setListed: jest.Mock;
  };
  let pairHistoryService: {
    getPaginatedHistoricalData: jest.Mock;
  };
  let dexTokenSummaryService: {
    createOrUpdateSummary: jest.Mock;
  };

  beforeEach(() => {
    dexTokenService = {
      findAll: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      findByAddress: jest.fn(),
      getTokenPrice: jest.fn(),
      getTokenPriceWithLiquidityAnalysis: jest.fn(),
      findBestPairForToken: jest.fn(),
      setListed: jest.fn(),
    };
    pairHistoryService = {
      getPaginatedHistoricalData: jest.fn().mockResolvedValue([]),
    };
    dexTokenSummaryService = {
      createOrUpdateSummary: jest.fn(),
    };

    controller = new DexTokensController(
      dexTokenService as any,
      {} as any,
      dexTokenSummaryService as any,
      pairHistoryService as any,
    );
  });

  describe('getByAddress', () => {
    it('returns the token when found', async () => {
      const token = { address: 'ct_token' };
      dexTokenService.findByAddress.mockResolvedValue(token);

      await expect(controller.getByAddress('ct_token')).resolves.toBe(token);
    });

    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.findByAddress.mockResolvedValue(null);

      await expect(controller.getByAddress('ct_token')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getTokenPrice', () => {
    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.findByAddress.mockResolvedValue(null);

      await expect(controller.getTokenPrice('ct_token')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(dexTokenService.getTokenPrice).not.toHaveBeenCalled();
    });

    it('merges the price payload with the token', async () => {
      const token = { address: 'ct_token', symbol: 'TOK' };
      dexTokenService.findByAddress.mockResolvedValue(token);
      dexTokenService.getTokenPrice.mockResolvedValue({
        price: '1.5',
        bestPath: ['a', 'b'],
      });

      const result: any = await controller.getTokenPrice('ct_token');

      expect(dexTokenService.getTokenPrice).toHaveBeenCalledWith(
        'ct_token',
        true,
      );
      expect(result).toEqual({
        price: '1.5',
        token,
        bestPath: ['a', 'b'],
      });
    });
  });

  describe('getTokenPriceAnalysis', () => {
    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.findByAddress.mockResolvedValue(null);

      await expect(
        controller.getTokenPriceAnalysis('ct_token'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        dexTokenService.getTokenPriceWithLiquidityAnalysis,
      ).not.toHaveBeenCalled();
    });

    it('throws NotFound when no price path is found', async () => {
      dexTokenService.findByAddress.mockResolvedValue({ address: 'ct_token' });
      dexTokenService.getTokenPriceWithLiquidityAnalysis.mockResolvedValue(
        null,
      );

      await expect(
        controller.getTokenPriceAnalysis('ct_token'),
      ).rejects.toThrow(/No price paths/);
    });

    it('returns the analysis when found', async () => {
      const analysis = { price: '2', bestPath: [], allPaths: [] };
      dexTokenService.findByAddress.mockResolvedValue({ address: 'ct_token' });
      dexTokenService.getTokenPriceWithLiquidityAnalysis.mockResolvedValue(
        analysis,
      );

      await expect(controller.getTokenPriceAnalysis('ct_token')).resolves.toBe(
        analysis,
      );
    });
  });

  describe('getTokenSummary', () => {
    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.findByAddress.mockResolvedValue(null);

      await expect(
        controller.getTokenSummary('ct_token'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        dexTokenSummaryService.createOrUpdateSummary,
      ).not.toHaveBeenCalled();
    });

    it('returns the summary with the address attached', async () => {
      dexTokenService.findByAddress.mockResolvedValue({ address: 'ct_token' });
      dexTokenSummaryService.createOrUpdateSummary.mockResolvedValue({
        total_volume: { ae: '10' },
        change: {},
      });

      const result: any = await controller.getTokenSummary('ct_token');

      expect(dexTokenSummaryService.createOrUpdateSummary).toHaveBeenCalledWith(
        'ct_token',
      );
      expect(result).toEqual({
        total_volume: { ae: '10' },
        change: {},
        address: 'ct_token',
      });
    });
  });

  describe('listAll', () => {
    it('forwards search params to dexTokenService.findAll', async () => {
      await controller.listAll(3, 20, 'wae', 'price', 'ASC');

      expect(dexTokenService.findAll).toHaveBeenCalledWith(
        { page: 3, limit: 20 },
        'wae',
        'price',
        'ASC',
        undefined,
      );
    });

    it('parses listed=true into a boolean filter', async () => {
      await controller.listAll(1, 100, '', 'created_at', 'DESC', 'true');

      expect(dexTokenService.findAll).toHaveBeenCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        true,
      );
    });

    it('parses listed=false into a boolean filter', async () => {
      await controller.listAll(1, 100, '', 'created_at', 'DESC', 'false');

      expect(dexTokenService.findAll).toHaveBeenCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        false,
      );
    });

    it('accepts listed=1 / listed=0 and is case-insensitive', async () => {
      await controller.listAll(1, 100, '', 'created_at', 'DESC', '1');
      expect(dexTokenService.findAll).toHaveBeenLastCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        true,
      );

      await controller.listAll(1, 100, '', 'created_at', 'DESC', '0');
      expect(dexTokenService.findAll).toHaveBeenLastCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        false,
      );

      await controller.listAll(1, 100, '', 'created_at', 'DESC', 'TRUE');
      expect(dexTokenService.findAll).toHaveBeenLastCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        true,
      );
    });

    it('treats an empty listed param as no filter', async () => {
      await controller.listAll(1, 100, '', 'created_at', 'DESC', '');

      expect(dexTokenService.findAll).toHaveBeenCalledWith(
        { page: 1, limit: 100 },
        '',
        'created_at',
        'DESC',
        undefined,
      );
    });

    it('rejects an invalid listed value with 400 instead of coercing it', async () => {
      await expect(
        controller.listAll(1, 100, '', 'created_at', 'DESC', 'yes'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(dexTokenService.findAll).not.toHaveBeenCalled();
    });
  });

  describe('getTokenHistory', () => {
    it('rejects out-of-range intervals before any lookup', async () => {
      await expect(
        controller.getTokenHistory('ct_token', 30, 'ae', 1, 100),
      ).rejects.toThrow('interval must be between 60 and 86400 seconds');

      expect(dexTokenService.findByAddress).not.toHaveBeenCalled();
    });

    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.findByAddress.mockResolvedValue(null);

      await expect(
        controller.getTokenHistory('ct_token', 3600, 'ae', 1, 100),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when no pool can chart the token', async () => {
      dexTokenService.findByAddress.mockResolvedValue({ address: 'ct_token' });
      dexTokenService.findBestPairForToken.mockResolvedValue(null);

      await expect(
        controller.getTokenHistory('ct_token', 3600, 'ae', 1, 100),
      ).rejects.toThrow(/No liquidity pool/);
    });

    it('delegates to the pair history service using the base token position', async () => {
      const pair = { address: 'ct_pair' };
      dexTokenService.findByAddress.mockResolvedValue({ address: 'ct_token' });
      dexTokenService.findBestPairForToken.mockResolvedValue({
        pair,
        basePosition: 'token1',
      });

      await controller.getTokenHistory('ct_token', 3600, 'usd', 2, 50);

      expect(
        pairHistoryService.getPaginatedHistoricalData,
      ).toHaveBeenCalledWith({
        pair,
        interval: 3600,
        fromToken: 'token1',
        convertTo: 'usd',
        page: 2,
        limit: 50,
      });
    });
  });

  describe('setListed', () => {
    it('returns the updated token', async () => {
      const token = { address: 'ct_token', listed: true };
      dexTokenService.setListed.mockResolvedValue(token);

      const result = await controller.setListed('ct_token', { listed: true });

      expect(dexTokenService.setListed).toHaveBeenCalledWith('ct_token', true);
      expect(result).toBe(token);
    });

    it('throws NotFound when the token does not exist', async () => {
      dexTokenService.setListed.mockResolvedValue(null);

      await expect(
        controller.setListed('ct_token', { listed: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
