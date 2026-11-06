import { resolveBullBoardSettings } from './bull-board.settings';

const PASSWORD = 'a-password-of-24-chars!!';

describe('resolveBullBoardSettings', () => {
  describe('in production', () => {
    const production = { NODE_ENV: 'production' };

    it('stays off without the opt-in, even with credentials', () => {
      expect(
        resolveBullBoardSettings({
          ...production,
          BULL_BOARD_USER: 'ops',
          BULL_BOARD_PASSWORD: PASSWORD,
        }),
      ).toEqual({ enabled: false });
      // The deploy writes empty values for keys that have no secret.
      expect(
        resolveBullBoardSettings({ ...production, ENABLE_BULL_BOARD: '' }),
      ).toEqual({ enabled: false });
    });

    it('refuses an opt-in without credentials instead of serving it open', () => {
      const settings = resolveBullBoardSettings({
        ...production,
        ENABLE_BULL_BOARD: 'true',
      });
      expect(settings.enabled).toBe(false);
      expect(settings).toHaveProperty('error');
    });

    it('refuses a missing user or a password under 16 characters', () => {
      for (const env of [
        { BULL_BOARD_PASSWORD: PASSWORD },
        { BULL_BOARD_USER: 'ops', BULL_BOARD_PASSWORD: 'x'.repeat(15) },
      ]) {
        expect(
          resolveBullBoardSettings({
            ...production,
            ENABLE_BULL_BOARD: 'true',
            ...env,
          }).enabled,
        ).toBe(false);
      }
    });

    it('accepts a password of exactly 16 characters', () => {
      expect(
        resolveBullBoardSettings({
          ...production,
          ENABLE_BULL_BOARD: 'true',
          BULL_BOARD_USER: 'ops',
          BULL_BOARD_PASSWORD: 'x'.repeat(16),
        }).enabled,
      ).toBe(true);
    });

    it('mounts read-only behind the login when opted in', () => {
      expect(
        resolveBullBoardSettings({
          ...production,
          ENABLE_BULL_BOARD: 'true',
          BULL_BOARD_USER: 'ops',
          BULL_BOARD_PASSWORD: PASSWORD,
          BULL_BOARD_READ_ONLY: '',
        }),
      ).toEqual({
        enabled: true,
        credentials: { user: 'ops', password: PASSWORD },
        readOnly: true,
      });
    });

    it('allows writes only when explicitly asked', () => {
      const settings = resolveBullBoardSettings({
        ...production,
        ENABLE_BULL_BOARD: 'true',
        BULL_BOARD_USER: 'ops',
        BULL_BOARD_PASSWORD: PASSWORD,
        BULL_BOARD_READ_ONLY: 'false',
      });
      expect(settings).toMatchObject({ enabled: true, readOnly: false });
    });
  });

  it('treats any NODE_ENV other than development or test like production', () => {
    // docker-compose-testnet.yml runs `staging` on a public port.
    for (const NODE_ENV of ['staging', 'Production']) {
      expect(resolveBullBoardSettings({ NODE_ENV })).toEqual({
        enabled: false,
      });
      expect(
        resolveBullBoardSettings({ NODE_ENV, ENABLE_BULL_BOARD: 'true' })
          .enabled,
      ).toBe(false);
    }
  });

  describe('in development and tests', () => {
    it('mounts without a login when no credentials are set', () => {
      for (const env of [
        { NODE_ENV: 'development' },
        { NODE_ENV: 'test' },
        {},
      ]) {
        expect(resolveBullBoardSettings(env)).toEqual({
          enabled: true,
          readOnly: true,
        });
      }
    });

    it('enforces credentials once any are set', () => {
      expect(
        resolveBullBoardSettings({
          NODE_ENV: 'development',
          BULL_BOARD_PASSWORD: PASSWORD,
        }).enabled,
      ).toBe(false);
      expect(
        resolveBullBoardSettings({
          NODE_ENV: 'development',
          BULL_BOARD_USER: 'ops',
          BULL_BOARD_PASSWORD: PASSWORD,
        }),
      ).toMatchObject({ credentials: { user: 'ops', password: PASSWORD } });
    });
  });
});
