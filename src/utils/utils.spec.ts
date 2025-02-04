import BigNumber from 'bignumber.js';
import { BigNumberTransformer } from './BigNumberTransformer';
import { fetchJson } from './common';

// Mock the global fetch function
global.fetch = jest.fn();

describe('fetchJson', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch JSON data and return the parsed response', async () => {
    const mockData = { message: 'Success' };
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue(mockData),
    });

    const result = await fetchJson('https://api.example.com/data');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      undefined,
    );
    expect(result).toEqual(mockData);
  });

  it('should return null for status 204 (No Content)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 204,
    });

    const result = await fetchJson('https://api.example.com/no-content');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/no-content',
      undefined,
    );
    expect(result).toBeNull();
  });

  it('should pass request options when provided', async () => {
    const mockData = { message: 'Success' };
    const mockOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue(mockData),
    });

    const result = await fetchJson('https://api.example.com/data', mockOptions);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      mockOptions,
    );
    expect(result).toEqual(mockData);
  });

  it('should throw an error if fetch fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network Error'));

    await expect(fetchJson('https://api.example.com/error')).rejects.toThrow(
      'Network Error',
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/error',
      undefined,
    );
  });
});

describe('BigNumberTransformer', () => {
  describe('from', () => {
    it('should return null when input is null', () => {
      expect(BigNumberTransformer.from(null)).toBeNull();
    });

    it('should return undefined when input is undefined', () => {
      expect(BigNumberTransformer.from(undefined)).toBeUndefined();
    });

    it('should convert a numeric string to a BigNumber', () => {
      const result = BigNumberTransformer.from('123.45');
      expect(result).toBeInstanceOf(BigNumber);
      expect(result?.toString()).toBe('123.45');
    });

    it('should convert a number to a BigNumber', () => {
      const result = BigNumberTransformer.from(123.45);
      expect(result).toBeInstanceOf(BigNumber);
      expect(result?.toString()).toBe('123.45');
    });
  });

  describe('to', () => {
    it('should return null when input is null', () => {
      expect(BigNumberTransformer.to(null)).toBeNull();
    });

    it('should return undefined when input is undefined', () => {
      expect(BigNumberTransformer.to(undefined)).toBeUndefined();
    });

    it('should convert a BigNumber to a string', () => {
      const bigNumber = new BigNumber('123.45');
      expect(BigNumberTransformer.to(bigNumber)).toBe('123.45');
    });
  });
});
