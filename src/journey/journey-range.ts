import { BadRequestException } from '@nestjs/common';
import { JOURNEY_LIMITS } from './journey.constants';

export type JourneyRange = {
  /** Inclusive first day, YYYY-MM-DD (UTC). */
  start_date: string;
  /** Inclusive last day, YYYY-MM-DD (UTC). */
  end_date: string;
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound (the day after end_date). */
  to: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string, name: string): Date {
  if (!DATE.test(value)) {
    throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException(`${name} must be a valid date`);
  }
  return date;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve the dashboard's date range. Defaults to the last 30 days (today
 * included); a range longer than 180 days is shortened from the start, since
 * nothing older than that is kept anyway.
 */
export function resolveJourneyRange(
  startDate?: string,
  endDate?: string,
  now: Date = new Date(),
): JourneyRange {
  const today = new Date(`${day(now)}T00:00:00.000Z`);
  const end = endDate ? parseDay(endDate, 'end_date') : today;
  let start = startDate
    ? parseDay(startDate, 'start_date')
    : new Date(
        end.getTime() - (JOURNEY_LIMITS.DEFAULT_RANGE_DAYS - 1) * DAY_MS,
      );
  if (start.getTime() > end.getTime()) {
    throw new BadRequestException('start_date must not be after end_date');
  }
  const earliest = new Date(
    end.getTime() - (JOURNEY_LIMITS.MAX_RANGE_DAYS - 1) * DAY_MS,
  );
  if (start.getTime() < earliest.getTime()) {
    start = earliest;
  }
  return {
    start_date: day(start),
    end_date: day(end),
    from: start,
    to: new Date(end.getTime() + DAY_MS),
  };
}
