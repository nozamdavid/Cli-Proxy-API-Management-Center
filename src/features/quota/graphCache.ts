import type { QuotaProviderType } from './providers/types';
import {
  opaqueQuotaSignature,
  type PooledQuotaProjectionPoint,
} from './mergedQuota';

export interface QuotaGraphSnapshotContributor {
  id: string;
  remainingPercent: number;
  resetAtMs: number | null;
}

export interface QuotaGraphSnapshotProjection {
  poolId: string;
  provider: QuotaProviderType;
  capacityPercent: number;
  membershipSignature: string;
  generatedAtMs: number;
  sourceObservedAtMs: number;
  points: PooledQuotaProjectionPoint[];
  burnRatePercentPerHour: number | null;
  nextResetAtMs: number | null;
  poolEmptyAtMs: number | null;
  resetOnly: boolean;
}

export interface QuotaGraphSnapshotPool {
  id: string;
  label: string;
  provider: QuotaProviderType;
  periodHours: number | null;
  eligibleCount: number;
  exposedCount: number;
  disabledCount: number;
  remainingPercent: number;
  capacityPercent: number;
  membershipSignature: string;
  historyStorageKey: string;
  observedAtMs: number;
  contributors: QuotaGraphSnapshotContributor[];
  projection?: QuotaGraphSnapshotProjection;
}

export interface QuotaGraphSnapshot {
  version: 1;
  savedAtMs: number;
  pools: QuotaGraphSnapshotPool[];
}

export interface QuotaGraphCacheStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface QuotaGraphCache {
  read: (scope: string, nowMs?: number) => QuotaGraphSnapshot | null;
  write: (scope: string, value: unknown, nowMs?: number) => QuotaGraphSnapshot | null;
  remove: (scope: string) => void;
}

export function writeQuotaGraphSnapshotIfSuccessful(
  cache: QuotaGraphCache,
  scope: string,
  value: unknown,
  refreshSuccessful: boolean,
  nowMs = Date.now()
): QuotaGraphSnapshot | null {
  return refreshSuccessful ? cache.write(scope, value, nowMs) : null;
}

const STORAGE_KEY = 'merged-quota-graph-cache-v1';
const VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_RESET_AGE_MS = 14 * MAX_AGE_MS;
const MAX_RESET_AHEAD_MS = 366 * MAX_AGE_MS;
const MAX_PROJECTION_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROJECTION_POINTS = 4_096;
const MAX_POOLS = 48;
const MAX_CONTRIBUTORS_PER_POOL = 2_000;
const MAX_SCOPES = 8;
const MAX_CACHE_BYTES = 512 * 1024;
const OPAQUE_ID = /^[a-f0-9]{16}$/;
const HISTORY_STORAGE_KEY = /^merged-quota-history-v2:[a-f0-9]{16}$/;
const LEGACY_HISTORY_STORAGE_KEY = /^merged-quota-history-v1:[a-f0-9]{16}$/;
const PROVIDERS: readonly QuotaProviderType[] = [
  'antigravity',
  'claude',
  'codex',
  'devin',
  'kimi',
  'meta',
  'plugin',
  'xai',
];

interface StoredEntry {
  scope: string;
  lastUsedAtMs: number;
  snapshot: QuotaGraphSnapshot;
}

interface StoredRoot {
  version: 1;
  entries: StoredEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isCount = (value: unknown, max = 10_000): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

const cacheSize = (value: unknown): number => JSON.stringify(value).length * 2;

const isSnapshotTime = (value: unknown, nowMs: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= nowMs - MAX_AGE_MS &&
  value <= nowMs + MAX_FUTURE_SKEW_MS;

const sanitizeContributor = (
  value: unknown,
  nowMs: number,
  observedAtMs: number
): QuotaGraphSnapshotContributor | null => {
  if (!isRecord(value)) return null;
  const { id, remainingPercent, resetAtMs } = value;
  if (
    typeof id !== 'string' ||
    !OPAQUE_ID.test(id) ||
    typeof remainingPercent !== 'number' ||
    !Number.isFinite(remainingPercent) ||
    remainingPercent < 0 ||
    remainingPercent > 100
  ) {
    return null;
  }
  if (resetAtMs !== null) {
    if (
      typeof resetAtMs !== 'number' ||
      !Number.isFinite(resetAtMs) ||
      resetAtMs < Math.max(0, observedAtMs - MAX_RESET_AGE_MS) ||
      resetAtMs > nowMs + MAX_RESET_AHEAD_MS
    ) {
      return null;
    }
  }
  return { id, remainingPercent, resetAtMs };
};

const sanitizeProjection = (
  value: unknown,
  pool: QuotaGraphSnapshotPool,
  nowMs: number
): QuotaGraphSnapshotProjection | null => {
  if (!isRecord(value)) return null;
  const {
    poolId,
    provider,
    capacityPercent,
    membershipSignature,
    generatedAtMs,
    sourceObservedAtMs,
    points: rawPoints,
    burnRatePercentPerHour,
    nextResetAtMs,
    poolEmptyAtMs,
    resetOnly,
  } = value;
  if (
    poolId !== pool.id ||
    provider !== pool.provider ||
    capacityPercent !== pool.capacityPercent ||
    membershipSignature !== pool.membershipSignature ||
    sourceObservedAtMs !== pool.observedAtMs ||
    !isSnapshotTime(generatedAtMs, nowMs) ||
    (generatedAtMs as number) < pool.observedAtMs - MAX_FUTURE_SKEW_MS ||
    !Array.isArray(rawPoints) ||
    rawPoints.length < 2 ||
    rawPoints.length > MAX_PROJECTION_POINTS ||
    (burnRatePercentPerHour !== null &&
      (typeof burnRatePercentPerHour !== 'number' ||
        !Number.isFinite(burnRatePercentPerHour) ||
        burnRatePercentPerHour <= 0 ||
        burnRatePercentPerHour > pool.capacityPercent * 6)) ||
    (nextResetAtMs !== null &&
      (typeof nextResetAtMs !== 'number' ||
        !Number.isFinite(nextResetAtMs) ||
        nextResetAtMs <= (generatedAtMs as number) ||
        nextResetAtMs > (generatedAtMs as number) + MAX_RESET_AHEAD_MS)) ||
    (poolEmptyAtMs !== null &&
      (typeof poolEmptyAtMs !== 'number' ||
        !Number.isFinite(poolEmptyAtMs) ||
        poolEmptyAtMs < (generatedAtMs as number) ||
        poolEmptyAtMs > (generatedAtMs as number) + MAX_PROJECTION_HORIZON_MS)) ||
    typeof resetOnly !== 'boolean' ||
    resetOnly !== (burnRatePercentPerHour === null && nextResetAtMs !== null)
  ) {
    return null;
  }

  const points: PooledQuotaProjectionPoint[] = [];
  let previousAtMs = generatedAtMs as number;
  let firstResetAtMs: number | null = null;
  for (let index = 0; index < rawPoints.length; index += 1) {
    const rawPoint = rawPoints[index];
    if (!isRecord(rawPoint)) return null;
    const { atMs, remainingPercent, reset } = rawPoint;
    if (
      typeof atMs !== 'number' ||
      !Number.isFinite(atMs) ||
      atMs < (generatedAtMs as number) ||
      atMs > (generatedAtMs as number) + MAX_PROJECTION_HORIZON_MS ||
      atMs < previousAtMs ||
      typeof remainingPercent !== 'number' ||
      !Number.isFinite(remainingPercent) ||
      remainingPercent < 0 ||
      remainingPercent > pool.capacityPercent ||
      typeof reset !== 'boolean' ||
      (index === 0 && (atMs !== generatedAtMs || reset))
    ) {
      return null;
    }
    if (reset && firstResetAtMs === null) firstResetAtMs = atMs;
    previousAtMs = atMs;
    points.push({ atMs, remainingPercent, reset });
  }

  const firstPoint = points[0];
  const hasRelevantFuturePoint = points.some((point) => point.atMs > (generatedAtMs as number));
  const nextResetWithinHorizon =
    nextResetAtMs !== null &&
    nextResetAtMs <= (generatedAtMs as number) + MAX_PROJECTION_HORIZON_MS;
  if (
    !firstPoint ||
    firstPoint.remainingPercent !== pool.remainingPercent ||
    !hasRelevantFuturePoint ||
    (nextResetAtMs === null && firstResetAtMs !== null) ||
    (firstResetAtMs !== null && firstResetAtMs !== nextResetAtMs) ||
    (nextResetWithinHorizon && firstResetAtMs !== nextResetAtMs)
  ) {
    return null;
  }

  return {
    poolId: poolId as string,
    provider: provider as QuotaProviderType,
    capacityPercent: capacityPercent as number,
    membershipSignature: membershipSignature as string,
    generatedAtMs: generatedAtMs as number,
    sourceObservedAtMs: sourceObservedAtMs as number,
    points,
    burnRatePercentPerHour: burnRatePercentPerHour as number | null,
    nextResetAtMs: nextResetAtMs as number | null,
    poolEmptyAtMs: poolEmptyAtMs as number | null,
    resetOnly,
  };
};

const sanitizePool = (value: unknown, nowMs: number): QuotaGraphSnapshotPool | null => {
  if (!isRecord(value)) return null;
  const {
    id,
    label,
    provider,
    periodHours,
    eligibleCount,
    exposedCount,
    disabledCount,
    remainingPercent,
    capacityPercent,
    membershipSignature,
    historyStorageKey,
    observedAtMs,
    contributors: rawContributors,
    projection: rawProjection,
  } = value;
  if (
    typeof id !== 'string' ||
    !OPAQUE_ID.test(id) ||
    typeof label !== 'string' ||
    label.length === 0 ||
    label.length > 240 ||
    typeof provider !== 'string' ||
    !PROVIDERS.includes(provider as QuotaProviderType) ||
    (periodHours !== null &&
      (typeof periodHours !== 'number' ||
        !Number.isFinite(periodHours) ||
        periodHours < 0 ||
        periodHours > 24 * 366)) ||
    !isCount(eligibleCount) ||
    !isCount(exposedCount) ||
    !isCount(disabledCount) ||
    typeof remainingPercent !== 'number' ||
    !Number.isFinite(remainingPercent) ||
    typeof capacityPercent !== 'number' ||
    !Number.isFinite(capacityPercent) ||
    typeof membershipSignature !== 'string' ||
    !OPAQUE_ID.test(membershipSignature) ||
    typeof historyStorageKey !== 'string' ||
    (historyStorageKey !== '' &&
      !HISTORY_STORAGE_KEY.test(historyStorageKey) &&
      !LEGACY_HISTORY_STORAGE_KEY.test(historyStorageKey)) ||
    !isSnapshotTime(observedAtMs, nowMs) ||
    !Array.isArray(rawContributors) ||
    rawContributors.length === 0 ||
    rawContributors.length > MAX_CONTRIBUTORS_PER_POOL
  ) {
    return null;
  }

  const contributors: QuotaGraphSnapshotContributor[] = [];
  const contributorIds = new Set<string>();
  for (const rawContributor of rawContributors) {
    const contributor = sanitizeContributor(rawContributor, nowMs, observedAtMs);
    if (!contributor || contributorIds.has(contributor.id)) return null;
    contributorIds.add(contributor.id);
    contributors.push(contributor);
  }
  const expectedCapacity = contributors.length * 100;
  const expectedRemaining = contributors.reduce(
    (sum, contributor) => sum + contributor.remainingPercent,
    0
  );
  if (
    capacityPercent !== expectedCapacity ||
    remainingPercent < 0 ||
    remainingPercent > capacityPercent ||
    Math.abs(remainingPercent - expectedRemaining) > 0.001 ||
    exposedCount < contributors.length
  ) {
    return null;
  }

  const pool: QuotaGraphSnapshotPool = {
    id,
    label,
    provider: provider as QuotaProviderType,
    periodHours: periodHours as number | null,
    eligibleCount,
    exposedCount,
    disabledCount,
    remainingPercent,
    capacityPercent,
    membershipSignature,
    historyStorageKey: HISTORY_STORAGE_KEY.test(historyStorageKey) ? historyStorageKey : '',
    observedAtMs,
    contributors,
  };
  const projection = sanitizeProjection(rawProjection, pool, nowMs);
  return projection ? { ...pool, projection } : pool;
};

export function createQuotaGraphCacheScope(normalizedHub: string, managementKey: string): string {
  const hub = normalizedHub.trim();
  const key = managementKey.trim();
  return hub && key ? opaqueQuotaSignature(`quota-graph-cache-v1\u0000${hub}\u0000${key}`) : '';
}

export function sanitizeQuotaGraphSnapshot(
  value: unknown,
  nowMs = Date.now()
): QuotaGraphSnapshot | null {
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    !isSnapshotTime(value.savedAtMs, nowMs) ||
    !Array.isArray(value.pools)
  ) {
    return null;
  }
  const pools: QuotaGraphSnapshotPool[] = [];
  const poolIds = new Set<string>();
  for (const rawPool of value.pools.slice(0, MAX_POOLS)) {
    const pool = sanitizePool(rawPool, nowMs);
    if (!pool || poolIds.has(pool.id)) return null;
    poolIds.add(pool.id);
    pools.push(pool);
  }
  return { version: VERSION, savedAtMs: value.savedAtMs, pools };
}

const sanitizeStoredRoot = (value: unknown, nowMs: number): StoredRoot => {
  if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.entries)) {
    return { version: VERSION, entries: [] };
  }
  const entries: StoredEntry[] = [];
  const scopes = new Set<string>();
  value.entries.slice(0, MAX_SCOPES * 2).forEach((rawEntry) => {
    if (!isRecord(rawEntry)) return;
    const { scope, lastUsedAtMs } = rawEntry;
    const snapshot = sanitizeQuotaGraphSnapshot(rawEntry.snapshot, nowMs);
    if (
      typeof scope !== 'string' ||
      !OPAQUE_ID.test(scope) ||
      !isSnapshotTime(lastUsedAtMs, nowMs) ||
      !snapshot ||
      scopes.has(scope)
    ) {
      return;
    }
    scopes.add(scope);
    entries.push({ scope, lastUsedAtMs, snapshot });
  });
  return {
    version: VERSION,
    entries: entries.sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs),
  };
};

const fitSnapshot = (value: unknown, nowMs: number): QuotaGraphSnapshot | null => {
  const sanitized = sanitizeQuotaGraphSnapshot(value, nowMs);
  if (!sanitized) return null;
  if (sanitized.pools.length === 0) return sanitized;
  let pools = sanitized.pools;
  let droppedProjections = false;
  while (pools.length > 0) {
    let candidate = { ...sanitized, pools };
    if (cacheSize(candidate) <= MAX_CACHE_BYTES - 1024) return candidate;
    if (!droppedProjections) {
      const withoutProjections = pools.map(({ projection: _projection, ...pool }) => pool);
      candidate = { ...sanitized, pools: withoutProjections };
      if (cacheSize(candidate) <= MAX_CACHE_BYTES - 1024) return candidate;
      pools = withoutProjections;
      droppedProjections = true;
      continue;
    }
    pools = pools.slice(0, -1);
  }
  return null;
};

const getRoot = (storage: QuotaGraphCacheStorage | null, nowMs: number): StoredRoot => {
  if (!storage) return { version: VERSION, entries: [] };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw
      ? sanitizeStoredRoot(JSON.parse(raw) as unknown, nowMs)
      : { version: VERSION, entries: [] };
  } catch {
    return { version: VERSION, entries: [] };
  }
};

const boundedEntries = (entries: StoredEntry[]): StoredEntry[] => {
  const sorted = [...entries].sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs);
  while (sorted.length > 0) {
    const candidate = sorted.slice(0, MAX_SCOPES);
    if (cacheSize({ version: VERSION, entries: candidate }) <= MAX_CACHE_BYTES) return candidate;
    sorted.pop();
  }
  return [];
};

export function createQuotaGraphCache(storage: QuotaGraphCacheStorage | null): QuotaGraphCache {
  const memory = new Map<string, StoredEntry>();

  const retainMemory = (entry: StoredEntry, nowMs: number): void => {
    const next = Array.from(memory.values()).filter(
      (existing) =>
        existing.scope !== entry.scope &&
        isSnapshotTime(existing.lastUsedAtMs, nowMs) &&
        sanitizeQuotaGraphSnapshot(existing.snapshot, nowMs) !== null
    );
    next.push(entry);
    const retained = boundedEntries(next);
    memory.clear();
    retained.forEach((item) => memory.set(item.scope, item));
  };

  return {
    read(scope, nowMs = Date.now()) {
      if (!scope || !OPAQUE_ID.test(scope)) return null;
      const root = getRoot(storage, nowMs);
      const stored = root.entries.find((entry) => entry.scope === scope);
      if (stored) {
        retainMemory(stored, nowMs);
        return stored.snapshot;
      }
      const fallback = memory.get(scope);
      if (
        fallback &&
        isSnapshotTime(fallback.lastUsedAtMs, nowMs) &&
        sanitizeQuotaGraphSnapshot(fallback.snapshot, nowMs)
      ) {
        const refreshed = { ...fallback, lastUsedAtMs: nowMs };
        retainMemory(refreshed, nowMs);
        return fallback.snapshot;
      }
      memory.delete(scope);
      return null;
    },
    write(scope, value, nowMs = Date.now()) {
      if (!scope || !OPAQUE_ID.test(scope)) return null;
      const snapshot = fitSnapshot(value, nowMs);
      if (!snapshot) return null;
      const entry = { scope, lastUsedAtMs: nowMs, snapshot };
      retainMemory(entry, nowMs);

      if (storage) {
        const previous = getRoot(storage, nowMs).entries.filter((item) => item.scope !== scope);
        const entries = boundedEntries([...previous, entry]);
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries }));
        } catch {
          // The bounded in-memory entry remains available for this page session.
        }
      }
      return memory.has(scope) ? snapshot : null;
    },
    remove(scope) {
      if (!scope) return;
      memory.delete(scope);
      if (!storage) return;
      const entries = getRoot(storage, Date.now()).entries.filter((item) => item.scope !== scope);
      try {
        if (entries.length === 0) storage.removeItem(STORAGE_KEY);
        else storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries }));
      } catch {
        // A storage failure must not prevent logout or connection switching.
      }
    },
  };
}

const browserStorage = (): QuotaGraphCacheStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const quotaGraphCache = createQuotaGraphCache(browserStorage());
