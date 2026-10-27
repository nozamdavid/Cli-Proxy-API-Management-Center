import { describe, expect, test } from 'bun:test';
import {
  createQuotaGraphCache,
  createQuotaGraphCacheScope,
  sanitizeQuotaGraphSnapshot,
  writeQuotaGraphSnapshotIfSuccessful,
  type QuotaGraphCacheStorage,
  type QuotaGraphSnapshot,
} from '@/features/quota/graphCache';
import { opaqueQuotaSignature, readQuotaPoolHistory } from '@/features/quota/mergedQuota';

const nowMs = Date.UTC(2026, 9, 26, 12, 0, 0);

const makeSnapshot = (savedAtMs = nowMs, remainingPercent = 75): QuotaGraphSnapshot => {
  const poolId = opaqueQuotaSignature('claude:weekly');
  const membershipSignature = opaqueQuotaSignature('claude:account.json');
  return {
    version: 1,
    savedAtMs,
    pools: [
      {
        id: poolId,
      label: 'Weekly · 5h',
      provider: 'claude',
      periodHours: 5,
      eligibleCount: 1,
      exposedCount: 1,
      disabledCount: 0,
      remainingPercent,
      capacityPercent: 100,
      membershipSignature,
      historyStorageKey: `merged-quota-history-v2:${opaqueQuotaSignature('history')}`,
      observedAtMs: savedAtMs,
      contributors: [
        {
          id: membershipSignature,
          remainingPercent,
          resetAtMs: savedAtMs + 60 * 60 * 1000,
        },
      ],
        projection: {
          poolId,
          provider: 'claude',
          capacityPercent: 100,
          membershipSignature,
          generatedAtMs: savedAtMs,
          sourceObservedAtMs: savedAtMs,
          points: [
            { atMs: savedAtMs, remainingPercent, reset: false },
            { atMs: savedAtMs + 30 * 60 * 1000, remainingPercent: 60, reset: false },
            { atMs: savedAtMs + 60 * 60 * 1000, remainingPercent: 100, reset: true },
            { atMs: savedAtMs + 2 * 60 * 60 * 1000, remainingPercent: 80, reset: false },
          ],
          burnRatePercentPerHour: 10,
          nextResetAtMs: savedAtMs + 60 * 60 * 1000,
          poolEmptyAtMs: null,
          resetOnly: false,
        },
      },
    ],
  };
};

const memoryStorage = (): QuotaGraphCacheStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

describe('quota graph snapshot cache', () => {
  test('hydrates synchronously after reload with scoped, opaque data', () => {
    const storage = memoryStorage();
    const scope = createQuotaGraphCacheScope('https://quota.example', 'management-secret');
    const firstPage = createQuotaGraphCache(storage);
    expect(firstPage.write(scope, makeSnapshot(), nowMs)).not.toBeNull();

    const reloadedPage = createQuotaGraphCache(storage);
    const hit = reloadedPage.read(scope, nowMs);
    expect(hit?.pools[0].remainingPercent).toBe(75);
    expect(hit?.pools[0].observedAtMs).toBe(nowMs);
    expect(hit?.pools[0].projection?.generatedAtMs).toBe(nowMs);
    expect(hit?.pools[0].projection?.points).toHaveLength(4);
    expect(hit?.pools[0].projection?.burnRatePercentPerHour).toBe(10);
    expect(hit?.pools[0].projection?.nextResetAtMs).toBe(nowMs + 60 * 60 * 1000);
    expect(hit?.pools[0].projection?.poolEmptyAtMs).toBeNull();
    expect(storage.values.size).toBe(1);
    expect(Array.from(storage.values.keys()).some((key) => key.startsWith('merged-quota-history')))
      .toBe(false);
    expect(
      readQuotaPoolHistory(
        storage,
        hit!.pools[0].historyStorageKey,
        hit!.pools[0].membershipSignature,
        nowMs,
        hit!.pools[0].capacityPercent
      ).points
    ).toEqual([]);

    const serialized = Array.from(storage.values.values()).join('');
    expect(serialized).not.toContain('management-secret');
    expect(serialized).not.toContain('account.json');
  });

  test('isolates hub and credential scopes and removes only the logged out scope', () => {
    const storage = memoryStorage();
    const cache = createQuotaGraphCache(storage);
    const firstScope = createQuotaGraphCacheScope('https://one.example', 'key-one');
    const secondScope = createQuotaGraphCacheScope('https://two.example', 'key-two');
    const sameHubDifferentKey = createQuotaGraphCacheScope('https://one.example', 'key-two');
    cache.write(firstScope, makeSnapshot(), nowMs);
    cache.write(secondScope, makeSnapshot(nowMs, 40), nowMs);

    expect(firstScope).not.toBe(secondScope);
    expect(firstScope).not.toBe(sameHubDifferentKey);
    expect(cache.read(firstScope, nowMs)?.pools[0].remainingPercent).toBe(75);
    expect(cache.read(secondScope, nowMs)?.pools[0].remainingPercent).toBe(40);
    cache.remove(firstScope);
    expect(cache.read(firstScope, nowMs)).toBeNull();
    expect(cache.read(secondScope, nowMs)?.pools[0].remainingPercent).toBe(40);
  });

  test('rejects invalid and expired snapshots', () => {
    const invalid = makeSnapshot();
    invalid.pools[0].capacityPercent = 200;
    expect(sanitizeQuotaGraphSnapshot(invalid, nowMs)).toBeNull();

    const storage = memoryStorage();
    const scope = createQuotaGraphCacheScope('https://quota.example', 'key');
    const cache = createQuotaGraphCache(storage);
    const oldTime = nowMs - 25 * 60 * 60 * 1000;
    expect(cache.write(scope, makeSnapshot(oldTime), oldTime)).not.toBeNull();
    expect(cache.read(scope, nowMs)).toBeNull();

    const corruptStorage = {
      getItem: () => '{invalid json',
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(createQuotaGraphCache(corruptStorage).read(scope, nowMs)).toBeNull();
  });

  test('drops invalid, oversized, expired, and membership-mismatched forecasts safely', () => {
    const oversized = makeSnapshot();
    oversized.pools[0].projection!.points = Array.from({ length: 4_097 }, (_, index) => ({
      atMs: nowMs + index,
      remainingPercent: 75,
      reset: false,
    }));

    const outOfRange = makeSnapshot();
    outOfRange.pools[0].projection!.points[1].remainingPercent = 101;

    const expired = makeSnapshot();
    expired.pools[0].projection!.generatedAtMs = nowMs - 25 * 60 * 60 * 1000;

    const wrongSource = makeSnapshot();
    wrongSource.pools[0].projection!.sourceObservedAtMs -= 1_000;

    const wrongScope = makeSnapshot();
    wrongScope.pools[0].membershipSignature = opaqueQuotaSignature('new membership');
    wrongScope.pools[0].contributors[0].id = wrongScope.pools[0].membershipSignature;

    const changedCapacity = makeSnapshot();
    changedCapacity.pools[0].contributors.push({
      id: opaqueQuotaSignature('claude:new-account'),
      remainingPercent: 25,
      resetAtMs: null,
    });
    changedCapacity.pools[0].capacityPercent = 200;
    changedCapacity.pools[0].remainingPercent = 100;
    changedCapacity.pools[0].eligibleCount = 2;
    changedCapacity.pools[0].exposedCount = 2;
    changedCapacity.pools[0].membershipSignature = opaqueQuotaSignature('two members');

    for (const snapshot of [oversized, outOfRange, expired, wrongSource, wrongScope, changedCapacity]) {
      const sanitized = sanitizeQuotaGraphSnapshot(snapshot, nowMs);
      expect(sanitized?.pools[0].remainingPercent).toBe(
        snapshot === changedCapacity ? 100 : 75
      );
      expect(sanitized?.pools[0].projection).toBeUndefined();
    }
  });

  test('accepts legacy graph snapshots without a saved forecast', () => {
    const legacySnapshot = makeSnapshot();
    delete legacySnapshot.pools[0].projection;

    const sanitized = sanitizeQuotaGraphSnapshot(legacySnapshot, nowMs);
    expect(sanitized?.pools[0].remainingPercent).toBe(75);
    expect(sanitized?.pools[0].projection).toBeUndefined();
  });

  test('keeps cached graph values but drops a pre-auth-scope history reference', () => {
    const legacySnapshot = makeSnapshot();
    legacySnapshot.pools[0].historyStorageKey =
      `merged-quota-history-v1:${opaqueQuotaSignature('legacy-history')}`;

    const sanitized = sanitizeQuotaGraphSnapshot(legacySnapshot, nowMs);
    expect(sanitized?.pools[0].remainingPercent).toBe(75);
    expect(sanitized?.pools[0].historyStorageKey).toBe('');
    expect(sanitized?.pools[0].projection?.points).toHaveLength(4);
  });

  test('keeps the last good snapshot during loading and replaces it on success', () => {
    const storage = memoryStorage();
    const cache = createQuotaGraphCache(storage);
    const scope = createQuotaGraphCacheScope('https://quota.example', 'key');
    cache.write(scope, makeSnapshot(), nowMs);
    const lastGoodProjection = cache.read(scope, nowMs)?.pools[0].projection;

    expect(
      writeQuotaGraphSnapshotIfSuccessful(
        cache,
        scope,
        { ...makeSnapshot(), pools: [] },
        false,
        nowMs
      )
    ).toBeNull();
    expect(cache.write(scope, { status: 'loading' }, nowMs)).toBeNull();
    expect(cache.read(scope, nowMs)?.pools[0].remainingPercent).toBe(75);
    expect(cache.read(scope, nowMs)?.pools[0].projection).toEqual(lastGoodProjection);

    expect(
      writeQuotaGraphSnapshotIfSuccessful(
        cache,
        scope,
        makeSnapshot(nowMs + 1_000, 50),
        true,
        nowMs + 1_000
      )?.pools[0].remainingPercent
    ).toBe(50);
    expect(cache.read(scope, nowMs + 1_000)?.pools[0].observedAtMs).toBe(nowMs + 1_000);
    expect(cache.read(scope, nowMs + 1_000)?.pools[0].projection?.generatedAtMs).toBe(
      nowMs + 1_000
    );
  });

  test('falls back to bounded memory when browser storage throws', () => {
    const failedStorage = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('storage unavailable');
      },
    };
    const cache = createQuotaGraphCache(failedStorage);
    const scope = createQuotaGraphCacheScope('https://quota.example', 'key');

    expect(cache.write(scope, makeSnapshot(), nowMs)?.pools[0].remainingPercent).toBe(75);
    expect(cache.read(scope, nowMs)?.pools[0].remainingPercent).toBe(75);
    expect(() => cache.remove(scope)).not.toThrow();
  });
});
