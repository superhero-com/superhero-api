import { toAettos } from '@aeternity/aepp-sdk';
import { Logger } from '@nestjs/common';

type ErrorLogger = Pick<Logger, 'error'>;

export function normalizeXUsername(value: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/^@+/, '');
  return normalized || null;
}

export function isValidAeAmount(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  return Number(value) > 0;
}

export function isValidPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function getRewardAmountAettos(params: {
  amountAe: string;
  logger: ErrorLogger;
  rewardLabel: string;
}): string | null {
  try {
    const amount = toAettos(params.amountAe);
    if (!/^\d+$/.test(amount) || amount === '0') {
      params.logger.error(
        `Skipping ${params.rewardLabel}, converted aettos amount is invalid: ${amount}`,
      );
      return null;
    }

    return amount;
  } catch (error) {
    params.logger.error(
      `Skipping ${params.rewardLabel}, failed to convert amount to aettos`,
      error instanceof Error ? error.stack : String(error),
    );
    return null;
  }
}

export async function processAddressWithGuard(params: {
  address: string;
  processingByAddress: Map<string, Promise<void>>;
  workFactory: () => Promise<void>;
  logger: ErrorLogger;
  errorMessage: string;
}): Promise<void> {
  const existingInFlight = params.processingByAddress.get(params.address);
  if (existingInFlight) {
    return existingInFlight;
  }

  const work = params.workFactory().catch((error) => {
    params.logger.error(
      params.errorMessage,
      error instanceof Error ? error.stack : String(error),
    );
  });
  params.processingByAddress.set(params.address, work);

  try {
    await work;
  } finally {
    if (params.processingByAddress.get(params.address) === work) {
      params.processingByAddress.delete(params.address);
    }
  }
}
