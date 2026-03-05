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
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
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
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
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
      expect.objectContaining({
        ...mockOptions,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual(mockData);
  });

  it('should throw an error if fetch fails', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network Error'));
    const request = fetchJson('https://api.example.com/error');

    const expectation = expect(request).rejects.toThrow('Network Error');
    await jest.runAllTimersAsync();
    await expectation;
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/error',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    jest.useRealTimers();
  });

  it('should not retry when caller signal is already aborted', async () => {
    jest.useFakeTimers();
    const abortError = new Error('aborted');
    (abortError as any).name = 'AbortError';
    (global.fetch as jest.Mock).mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();

    const request = fetchJson('https://api.example.com/aborted', {
      signal: controller.signal,
    });
    const expectation = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(global.fetch).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
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
