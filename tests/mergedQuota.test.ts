import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import type { AggregateAntigravityAccount } from '@/services/api/quotaAggregate';
import {
  appendQuotaPoolHistory,
  createQuotaHistoryScope,
  inferPooledBurnRate,
  isMergedQuotaSessionCurrent,
  mergedQuotaWindowKey,
  projectPooledQuota,
  projectStoredQuotaWindows,
  representativeQuotaObservationTime,
  retainQuotaPoolHistories,
  QUOTA_HISTORY_MAX_POINTS,
  readQuotaPoolHistory,
  sanitizeQuotaPoolHistory,
  summarizePooledQuota,
  summarizeAntigravityBuckets,
  writeQuotaPoolHistory,
  type QuotaPoolHistory,
  type QuotaPoolHistoryStorage,
} from '@/features/quota/mergedQuota';
import { createQuotaGraphCacheScope } from '@/features/quota/graphCache';

const antigravityAccount = (
  name: string,
  bucket?: { bucketId?: string; window?: string; remainingFraction: number | null },
  fields: Partial<AggregateAntigravityAccount> = {}
): AggregateAntigravityAccount => ({
  name,
  disabled: false,
  plan: null,
  groups: bucket
    ? [{ displayName: 'Gemini', buckets: [bucket] }]
    : [],
  ...fields,
});

describe('merged quota projection', () => {
  test('uses the nine accounts exposing a bucket when ten accounts are present', () => {
    const accounts = Array.from({ length: 10 }, (_, index) =>
      antigravityAccount(
        `account-${index}`,
        index < 9
          ? { bucketId: 'weekly', window: 'week', remainingFraction: 1 }
          : undefined
      )
    );

    expect(summarizeAntigravityBuckets(accounts)).toEqual([
      expect.objectContaining({
        groupDisplayName: 'Gemini',
        bucketLabel: 'weekly',
        remainingFractionSum: 9,
        capacity: 9,
        coverage: 9,
        exposed: 9,
        unknown: 0,
        remainingPercent: 100,
      }),
    ]);
  });

  test('keeps zero as a known value and leaves missing fractions unavailable', () => {
    const accounts = [
      antigravityAccount('zero', {
        bucketId: 'weekly',
        window: 'week',
        remainingFraction: 0,
      }),
      antigravityAccount('missing', {
        bucketId: 'weekly',
        window: 'week',
        remainingFraction: null,
      }),
      antigravityAccount(
        'failed',
        { bucketId: 'weekly', window: 'week', remainingFraction: 0.5 },
        { error: 'Unavailable' }
      ),
      antigravityAccount(
        'disabled',
        { bucketId: 'weekly', window: 'week', remainingFraction: 1 },
        { disabled: true }
      ),
    ];

    expect(summarizeAntigravityBuckets(accounts)).toEqual([
      expect.objectContaining({
        remainingFractionSum: 0,
        capacity: 1,
        coverage: 1,
        exposed: 2,
        unknown: 1,
        remainingPercent: 0,
      }),
    ]);

    expect(
      summarizeAntigravityBuckets([
        antigravityAccount('unknown', {
          bucketId: 'weekly',
          window: 'week',
          remainingFraction: null,
        }),
      ])
    ).toEqual([
      expect.objectContaining({
        remainingFractionSum: 0,
        capacity: 0,
        coverage: 0,
        exposed: 1,
        unknown: 1,
        remainingPercent: null,
      }),
    ]);
  });

  test('separates Antigravity bucket windows and adapter units and durations', () => {
    const buckets = summarizeAntigravityBuckets([
      antigravityAccount('weekly', {
        bucketId: 'shared',
        window: 'week',
        remainingFraction: 0.5,
      }),
      antigravityAccount('session', {
        bucketId: 'shared',
        window: '5h',
        remainingFraction: 0.25,
      }),
      antigravityAccount('unidentified', { remainingFraction: 0.75 }),
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((item) => item.window).sort()).toEqual(['5h', 'week']);

    const windows = projectStoredQuotaWindows(
      'claude',
      { name: 'claude.json' } as AuthFileItem,
      {
        status: 'success',
        windows: [
          { id: 'weekly', usedPercent: 20, periodHours: 168, resetAtMs: 1_800_000_000_000 },
          { id: 'weekly', usedPercent: 20, periodHours: 120 },
        ],
      }
    );
    expect(windows).toHaveLength(2);
    expect(windows[0].key).not.toBe(windows[1].key);
    expect(windows[0].resetAtMs).toBe(1_800_000_000_000);
    expect(
      mergedQuotaWindowKey('claude', '', 'weekly', 'remaining-percent', 168)
    ).not.toBe(mergedQuotaWindowKey('claude', '', 'weekly', 'credits', 168));
  });

  test('accepts only a response from the same request, cache, and connection session', () => {
    const current = { requestId: 4, cacheGeneration: 12, connectionRevision: 3 };
    expect(isMergedQuotaSessionCurrent(current, { ...current })).toBe(true);
    expect(isMergedQuotaSessionCurrent(current, { ...current, requestId: 5 })).toBe(false);
    expect(isMergedQuotaSessionCurrent(current, { ...current, cacheGeneration: 13 })).toBe(false);
    expect(isMergedQuotaSessionCurrent(current, { ...current, connectionRevision: 4 })).toBe(
      false
    );
  });
});

describe('pooled quota history and projection', () => {
  test('retains temporarily hidden histories for the current backend within a fixed bound', () => {
    const retained = retainQuotaPoolHistories(
      {
        visible: { connectionSignature: 'backend-a', lastUsedAtMs: 1, value: 'old' },
        hidden: { connectionSignature: 'backend-a', lastUsedAtMs: 4, value: 'kept' },
        oldHidden: { connectionSignature: 'backend-a', lastUsedAtMs: 2, value: 'evicted' },
        otherBackend: { connectionSignature: 'backend-b', lastUsedAtMs: 10, value: 'dropped' },
      },
      {
        visible: { connectionSignature: 'backend-a', lastUsedAtMs: 11, value: 'current' },
      },
      'backend-a',
      2
    );

    expect(retained).toEqual({
      visible: { connectionSignature: 'backend-a', lastUsedAtMs: 11, value: 'current' },
      hidden: { connectionSignature: 'backend-a', lastUsedAtMs: 4, value: 'kept' },
    });
  });

  test('accepts fresh pool observations only when contributor times span at most 60 seconds', () => {
    expect(representativeQuotaObservationTime([1_000, 61_001])).toBeNull();
    expect(representativeQuotaObservationTime([1_000, 31_000, 61_000])).toBe(31_000);
    expect(representativeQuotaObservationTime([1_000, Number.NaN])).toBeNull();
  });

  test('sums known remaining percentages and assigns 100 points of capacity per account', () => {
    const tenAccounts = Array.from({ length: 10 }, (_, index) => ({
      key: `account-${index}`,
      remainingPercent: 100,
      resetAtMs: null,
      planMultiplier: 8,
    }));
    const threeAccounts = [
      { key: 'zero', remainingPercent: 0, resetAtMs: null },
      { key: 'half', remainingPercent: 50, resetAtMs: null },
      { key: 'full', remainingPercent: 100, resetAtMs: null },
    ];

    expect(summarizePooledQuota(tenAccounts)).toMatchObject({
      remainingPercent: 1000,
      capacityPercent: 1000,
      contributors: expect.arrayContaining([
        expect.objectContaining({ key: 'account-0', remainingPercent: 100 }),
      ]),
    });
    expect(summarizePooledQuota(threeAccounts)).toMatchObject({
      remainingPercent: 150,
      capacityPercent: 300,
      contributors: expect.arrayContaining([
        expect.objectContaining({ key: 'zero', remainingPercent: 0 }),
      ]),
    });
  });

  test('bounds snapshots and drops invalid or mismatched persisted input', () => {
    const nowMs = 1_800_000_000_000;
    const points = Array.from({ length: QUOTA_HISTORY_MAX_POINTS + 3 }, (_, index) => ({
      atMs: nowMs - (QUOTA_HISTORY_MAX_POINTS + 2 - index) * 60_000,
      remainingPercent: 50,
      capacityPercent: 100,
      resetAtMs: [],
    }));
    const sanitized = sanitizeQuotaPoolHistory(
      { version: 1, membershipSignature: 'member-a', points },
      'member-a',
      nowMs,
      100
    );
    expect(sanitized.points).toHaveLength(QUOTA_HISTORY_MAX_POINTS);
    expect(
      sanitizeQuotaPoolHistory(
        { version: 1, membershipSignature: 'member-b', points },
        'member-a',
        nowMs,
        100
      ).points
    ).toHaveLength(0);
    expect(
      sanitizeQuotaPoolHistory(
        {
          version: 1,
          membershipSignature: 'member-a',
          points: [{ atMs: nowMs, remainingPercent: 101, capacityPercent: 100 }],
        },
        'member-a',
        nowMs,
        100
      ).points
    ).toHaveLength(0);
  });

  test('keeps local persistence opaque and degrades when browser storage fails', () => {
    const scope = createQuotaHistoryScope(
      'https://backend.example',
      'claude-weekly-window',
      ['account@example.com']
    );
    const otherBackend = createQuotaHistoryScope(
      'https://other-backend.example',
      'claude-weekly-window',
      ['account@example.com']
    );
    expect(scope.storageKey).not.toContain('backend.example');
    expect(scope.storageKey).not.toContain('account@example.com');
    expect(scope.storageKey).not.toBe(otherBackend.storageKey);

    const storage: QuotaPoolHistoryStorage = {
      getItem: () => '{invalid json',
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
    expect(
      readQuotaPoolHistory(storage, scope.storageKey, scope.membershipSignature).points
    ).toEqual([]);
    expect(() =>
      writeQuotaPoolHistory(storage, scope.storageKey, {
        membershipSignature: scope.membershipSignature,
        points: [],
      })
    ).not.toThrow();
  });

  test('isolates history and burn samples by authenticated management identity', () => {
    const nowMs = Date.now();
    const firstIdentity = createQuotaGraphCacheScope('https://same.example', 'management-a');
    const secondIdentity = createQuotaGraphCacheScope('https://same.example', 'management-b');
    const contributors = ['claude:credential.json'];
    const firstScope = createQuotaHistoryScope(
      firstIdentity,
      'claude-weekly-window',
      contributors
    );
    const secondScope = createQuotaHistoryScope(
      secondIdentity,
      'claude-weekly-window',
      contributors
    );
    const values = new Map<string, string>();
    const storage: QuotaPoolHistoryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const history: QuotaPoolHistory = {
      membershipSignature: firstScope.membershipSignature,
      points: Array.from({ length: 5 }, (_, index) => ({
        atMs: nowMs - (4 - index) * 3 * 60 * 1000,
        remainingPercent: 100 - index * 5,
        capacityPercent: 100,
        resetAtMs: [],
      })),
    };
    writeQuotaPoolHistory(storage, firstScope.storageKey, history);
    const firstHistory = readQuotaPoolHistory(
      storage,
      firstScope.storageKey,
      firstScope.membershipSignature,
      nowMs,
      100
    );
    const secondHistory = readQuotaPoolHistory(
      storage,
      secondScope.storageKey,
      secondScope.membershipSignature,
      nowMs,
      100
    );

    expect(firstScope.membershipSignature).toBe(secondScope.membershipSignature);
    expect(firstScope.storageKey).not.toBe(secondScope.storageKey);
    expect(inferPooledBurnRate(firstHistory, firstScope.membershipSignature, 100, nowMs)).not.toBeNull();
    expect(secondHistory.points).toHaveLength(0);
    expect(inferPooledBurnRate(secondHistory, secondScope.membershipSignature, 100, nowMs)).toBeNull();
    expect(
      retainQuotaPoolHistories(
        { pool: { connectionSignature: firstIdentity, lastUsedAtMs: nowMs } },
        {},
        secondIdentity
      )
    ).toEqual({});
  });

  test('projects per-account resets with upward jumps capped at pooled capacity', () => {
    const nowMs = 1_800_000_000_000;
    const contributors = [
      { key: 'a', remainingPercent: 25, resetAtMs: nowMs + 60 * 60 * 1000 },
      { key: 'b', remainingPercent: 50, resetAtMs: nowMs + 60 * 60 * 1000 },
      { key: 'c', remainingPercent: 100, resetAtMs: null },
    ];
    const history: QuotaPoolHistory = { membershipSignature: 'members', points: [] };
    const projection = projectPooledQuota(contributors, history, 'members', nowMs);
    const resetPoint = projection.points.find((point) => point.reset);

    expect(projection.resetOnly).toBe(true);
    expect(projection.nextResetAtMs).toBe(nowMs + 60 * 60 * 1000);
    expect(resetPoint?.remainingPercent).toBe(300);
    expect(Math.max(...projection.points.map((point) => point.remainingPercent))).toBe(300);
  });

  test('infers burn only across comparable observations without reset/membership changes', () => {
    const nowMs = 1_800_000_000_000;
    const history: QuotaPoolHistory = {
      membershipSignature: 'members-a',
      points: Array.from({ length: 6 }, (_, index) => ({
        atMs: nowMs - (5 - index) * 2 * 60 * 1000,
        remainingPercent: 300 - index * 2,
        capacityPercent: 300,
        resetAtMs: [],
      })),
    };
    expect(inferPooledBurnRate(history, 'members-a', 300, nowMs)).toBeCloseTo(60);
    expect(inferPooledBurnRate(history, 'members-b', 300, nowMs)).toBeNull();

    const resetCrossing: QuotaPoolHistory = {
      ...history,
      points: history.points.map((point) => ({
        ...point,
        resetAtMs: [nowMs - 1 * 60 * 1000],
      })),
    };
    expect(inferPooledBurnRate(resetCrossing, 'members-a', 300, nowMs)).toBeNull();
  });

  test('does not invent measurements or a usage slope without recorded observations', () => {
    const history: QuotaPoolHistory = { membershipSignature: 'members', points: [] };
    const nowMs = 1_800_000_000_000;
    const appended = appendQuotaPoolHistory(
      history,
      'members',
      {
        atMs: nowMs,
        remainingPercent: 55,
        capacityPercent: 100,
        resetAtMs: [],
      },
      nowMs
    );
    const projection = projectPooledQuota(
      [{ key: 'account', remainingPercent: 55, resetAtMs: null }],
      appended,
      'members',
      nowMs
    );
    const duplicate = appendQuotaPoolHistory(
      appended,
      'members',
      {
        atMs: nowMs,
        remainingPercent: 54,
        capacityPercent: 100,
        resetAtMs: [],
      },
      nowMs
    );

    expect(appended.points).toHaveLength(1);
    expect(duplicate.points).toHaveLength(1);
    expect(projection.burnRatePercentPerHour).toBeNull();
    expect(projection.points).toHaveLength(1);
  });
});
