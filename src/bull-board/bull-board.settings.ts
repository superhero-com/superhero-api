export const BULL_BOARD_MIN_PASSWORD_LENGTH = 16;

export interface BullBoardCredentials {
  user: string;
  password: string;
}

export interface BullBoardSettings {
  enabled: boolean;
  readOnly?: boolean;
  credentials?: BullBoardCredentials;
  /** Why an opt-in was refused; logged at boot. */
  error?: string;
}

/**
 * Decide whether to mount Bull Board and how to lock it down.
 *
 * The board can add, edit and retry jobs on every queue, and job data holds
 * push tokens, so it must never be served open on a deployed server. Only a
 * development or test run gets it without a login. Any other NODE_ENV, such as
 * the `staging` of docker-compose-testnet.yml, is treated like production: the
 * board needs an explicit opt-in plus credentials. A misconfigured opt-in is
 * refused rather than served without a login.
 */
export function resolveBullBoardSettings(
  env: NodeJS.ProcessEnv = process.env,
): BullBoardSettings {
  const isLocal =
    !env.NODE_ENV || env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (!isLocal && env.ENABLE_BULL_BOARD !== 'true') {
    return { enabled: false };
  }

  const user = env.BULL_BOARD_USER ?? '';
  const password = env.BULL_BOARD_PASSWORD ?? '';
  const readOnly = env.BULL_BOARD_READ_ONLY !== 'false';

  if (isLocal && !user && !password) {
    return { enabled: true, readOnly };
  }
  if (!user || password.length < BULL_BOARD_MIN_PASSWORD_LENGTH) {
    return {
      enabled: false,
      error:
        'Bull Board is not mounted: set BULL_BOARD_USER and a ' +
        `BULL_BOARD_PASSWORD of at least ${BULL_BOARD_MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  return { enabled: true, credentials: { user, password }, readOnly };
}
