import { detectPostLanguage } from './post-language.util';

describe('detectPostLanguage', () => {
  // The contract test vectors: each pins one detector decision.
  it.each([
    ['gm frens, AE to the moon', 'en'],
    ['我喜欢 bitcoin', 'zh'],
    ['Hello world 中', 'en'],
    ['Привет, check this out', 'ru'],
    ['مرحبا بالجميع #BITCOIN https://superhero.com/trends', 'ar'],
    [
      '#BITCOIN https://x.com/abc ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      'und',
    ],
    ['🚀🚀🚀 100%', 'und'],
    ['#比特币 很好', 'zh'],
    ['Ça va? Très bien', 'en'],
    ['中文 и русский', 'ru'],
  ])('detects %j as %s', (content, expected) => {
    expect(detectPostLanguage(content)).toBe(expected);
  });

  it('returns und for empty or missing content', () => {
    expect(detectPostLanguage('')).toBe('und');
    expect(detectPostLanguage(null)).toBe('und');
    expect(detectPostLanguage(undefined)).toBe('und');
  });
});
