import { BadRequestException } from '@nestjs/common';
import { JOURNEY_FUNNELS } from './journey.constants';
import { buildFunnelSql, buildFunnelSteps } from './journey-query.service';
import { resolveJourneyRange } from './journey-range';

describe('resolveJourneyRange', () => {
  const now = new Date('2026-10-30T15:00:00Z');

  it('defaults to the last 30 days including today', () => {
    const range = resolveJourneyRange(undefined, undefined, now);
    expect(range.start_date).toBe('2026-10-01');
    expect(range.end_date).toBe('2026-10-30');
    expect(range.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  it('caps the range at 180 days', () => {
    const range = resolveJourneyRange('2025-01-01', '2026-10-30', now);
    const days =
      (range.to.getTime() - range.from.getTime()) / (24 * 3600 * 1000);
    expect(days).toBe(180);
  });

  it.each([
    ['2026-13-01', undefined],
    ['2026-02-30', undefined],
    ['yesterday', undefined],
    [undefined, '30-10-2026'],
    ['2026-10-10', '2026-10-01'],
  ])('rejects %s .. %s', (start, end) => {
    expect(() => resolveJourneyRange(start, end, now)).toThrow(
      BadRequestException,
    );
  });
});

describe('buildFunnelSteps', () => {
  const onboarding = JOURNEY_FUNNELS.find((f) => f.id === 'onboarding');

  it('computes % of start, % kept, lost and % lost per step', () => {
    const { steps } = buildFunnelSteps(
      onboarding,
      [1000, 650, 300, 240, 180, 90, 9],
      [null, 12, 60, 30, 45, 600, 3600],
    );
    expect(steps[0]).toMatchObject({
      label: 'Profile page',
      count: 1000,
      pctOfStart: 100,
      pctKeptFromPrevious: null,
      lostFromPrevious: 0,
      pctLostFromPrevious: null,
    });
    expect(steps[1]).toMatchObject({
      label: 'Clicked Edit',
      count: 650,
      pctOfStart: 65,
      pctKeptFromPrevious: 65,
      lostFromPrevious: 350,
      pctLostFromPrevious: 35,
      medianSecondsFromPrevious: 12,
    });
    expect(steps[2]).toMatchObject({
      count: 300,
      pctOfStart: 30,
      pctKeptFromPrevious: 46.2,
      lostFromPrevious: 350,
      pctLostFromPrevious: 53.8,
    });
    expect(steps[6]).toMatchObject({ pctOfStart: 0.9, lostFromPrevious: 81 });
  });

  it('orders drop-offs by people lost, then by % lost', () => {
    const { topDropOffs } = buildFunnelSteps(
      onboarding,
      [1000, 650, 300, 240, 180, 90, 9],
      [],
    );
    // 350 lost twice: the step that lost a larger share comes first.
    expect(topDropOffs.slice(0, 3)).toEqual([
      {
        fromIndex: 1,
        toIndex: 2,
        from: 'Clicked Edit',
        to: 'Claim Superhero account',
        lost: 350,
        pctLost: 53.8,
      },
      {
        fromIndex: 0,
        toIndex: 1,
        from: 'Profile page',
        to: 'Clicked Edit',
        lost: 350,
        pctLost: 35,
      },
      {
        fromIndex: 4,
        toIndex: 5,
        from: 'X connected',
        to: 'Posted',
        lost: 90,
        pctLost: 50,
      },
    ]);
  });

  it('handles an empty funnel without dividing by zero', () => {
    const { steps, topDropOffs } = buildFunnelSteps(onboarding, [], []);
    expect(steps.every((s) => s.count === 0 && s.pctOfStart === 0)).toBe(true);
    expect(steps[1].pctLostFromPrevious).toBeNull();
    expect(topDropOffs).toEqual([]);
  });
});

describe('buildFunnelSql', () => {
  it('chains one CTE per step, each strictly after the previous match', () => {
    const sql = buildFunnelSql(3);
    expect(sql).toContain('s1 AS');
    expect(sql).toContain('s3 AS');
    expect(sql).not.toContain('s4 AS');
    expect(sql).toContain('e.occurred_at > p.t');
    expect(sql).toContain('e.event = $5');
  });
});
