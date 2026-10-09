export function assertShortsEnvironment() {
  if (process.env.ENABLE_SHORTS !== 'true')
    throw new Error('Shorts is disabled');
  if (process.env.SHORTS_TESTNET_MVP !== '1')
    throw new Error('Explicit testnet mode required');
  if (process.env.AE_NETWORK_ID && process.env.AE_NETWORK_ID !== 'ae_uat') {
    throw new Error('Shorts currently supports testnet only');
  }
  if (process.env.NODE_ENV === 'production') {
    if (process.env.AE_NETWORK_ID !== 'ae_uat')
      throw new Error('Set AE_NETWORK_ID=ae_uat');
    if (
      process.env.SHORTS_DEMO_CONNECTED_WALLET === '1' ||
      process.env.SHORTS_DEMO_AUTO_APPROVE === '1'
    ) {
      throw new Error('Local demo shortcuts cannot run in hosted Shorts');
    }
    const origin = new URL(process.env.SHORTS_WEB_ORIGIN || '');
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== process.env.SHORTS_WEB_ORIGIN
    ) {
      throw new Error(
        'SHORTS_WEB_ORIGIN must be the exact HTTPS website origin',
      );
    }
    if (!process.env.SHORTS_DATA_DIR?.startsWith('/'))
      throw new Error('Mount an absolute SHORTS_DATA_DIR');
  }
}
