import type { AuthFileItem } from '@/types';
import type { QuotaProviderType } from './providers/types';
import type {
  AggregateAntigravityAccount,
  AggregateQuotaBucket,
  AggregateQuotaGroup,
} from '@/services/api/quotaAggregate';

export interface AntigravityBucketSummary {
  key: string;
  groupDisplayName: string;
  bucketLabel: string;
  window: string | null;
  remainingFractionSum: number;
  capacity: number;
  coverage: number;
  exposed: number;
  unknown: number;
  remainingPercent: number | null;
}

export interface MergedQuotaWindow {
  key: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  remainingPercent: number | null;
  periodHours: number | null;
  resetAtMs: number | null;
}

export interface QuotaPoolContributor {
  key: string;
  remainingPercent: number | null;
  resetAtMs?: number | null;
}

export interface PooledQuotaContributor extends QuotaPoolContributor {
  remainingPercent: number;
  resetAtMs: number | null;
}

export interface PooledQuotaSummary {
  contributors: PooledQuotaContributor[];
  remainingPercent: number;
  capacityPercent: number;
}

export interface QuotaPoolHistoryPoint {
  atMs: number;
  remainingPercent: number;
  capacityPercent: number;
  resetAtMs: number[];
}

export interface QuotaPoolHistory {
  membershipSignature: string;
  points: QuotaPoolHistoryPoint[];
}

export interface QuotaPoolHistoryStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface QuotaHistoryScope {
  storageKey: string;
  membershipSignature: string;
}

export interface RetainableQuotaPoolHistory {
  connectionSignature: string;
  lastUsedAtMs: number;
}

export interface PooledQuotaProjectionPoint {
  atMs: number;
  remainingPercent: number;
  reset: boolean;
}

export interface PooledQuotaProjection {
  points: PooledQuotaProjectionPoint[];
  burnRatePercentPerHour: number | null;
  nextResetAtMs: number | null;
  poolEmptyAtMs: number | null;
  resetOnly: boolean;
}

export const QUOTA_HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const QUOTA_HISTORY_MAX_POINTS = 2016;
export const MAX_IN_MEMORY_POOL_HISTORIES = 128;
export const MAX_QUOTA_OBSERVATION_SPREAD_MS = 60_000;

const MAX_QUOTA_HISTORY_ACCOUNTS = 10_000;
const MAX_QUOTA_FORECAST_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_BURN_SAMPLES = 3;
const MIN_BURN_SPAN_MS = 10 * 60 * 1000;
const MAX_BURN_GAP_MS = 3 * 60 * 1000;

/** Keep visible and recently hidden pools, while dropping histories from other backends. */
export function retainQuotaPoolHistories<T extends RetainableQuotaPoolHistory>(
  previous: Readonly<Record<string, T>>,
  visible: Readonly<Record<string, T>>,
  connectionSignature: string,
  maxEntries = MAX_IN_MEMORY_POOL_HISTORIES
): Record<string, T> {
  const retained = new Map<string, T>();
  const visibleKeys = new Set(Object.keys(visible));
  Object.entries(previous).forEach(([key, item]) => {
    if (item.connectionSignature === connectionSignature) retained.set(key, item);
  });
  Object.entries(visible).forEach(([key, item]) => {
    if (item.connectionSignature === connectionSignature) retained.set(key, item);
  });

  const limit = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 0;
  return Object.fromEntries(
    Array.from(retained.entries())
      .sort(
        (left, right) =>
          Number(visibleKeys.has(right[0])) - Number(visibleKeys.has(left[0])) ||
          right[1].lastUsedAtMs - left[1].lastUsedAtMs
      )
      .slice(0, limit)
  );
}

/** Use a real contributor observation time only when the pool was sampled closely together. */
export function representativeQuotaObservationTime(
  observationTimes: readonly number[],
  maxSpreadMs = MAX_QUOTA_OBSERVATION_SPREAD_MS
): number | null {
  if (
    observationTimes.length === 0 ||
    observationTimes.some((time) => !Number.isFinite(time)) ||
    !Number.isFinite(maxSpreadMs) ||
    maxSpreadMs < 0
  ) {
    return null;
  }
  const sorted = [...observationTimes].sort((left, right) => left - right);
  if (sorted[sorted.length - 1] - sorted[0] > maxSpreadMs) return null;
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Each known account contributes exactly 100 percentage points of capacity. */
export function summarizePooledQuota(
  contributors: readonly QuotaPoolContributor[]
): PooledQuotaSummary {
  const seen = new Set<string>();
  const known = contributors.flatMap((contributor): PooledQuotaContributor[] => {
    const value = contributor.remainingPercent;
    if (
      !contributor.key ||
      seen.has(contributor.key) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    ) {
      return [];
    }
    seen.add(contributor.key);
    const resetAtMs =
      typeof contributor.resetAtMs === 'number' && Number.isFinite(contributor.resetAtMs)
        ? contributor.resetAtMs
        : null;
    return [{ key: contributor.key, remainingPercent: value, resetAtMs }];
  });

  return {
    contributors: known,
    remainingPercent: known.reduce((sum, contributor) => sum + contributor.remainingPercent, 0),
    capacityPercent: known.length * 100,
  };
}

/** A stable opaque hash for local history keys; the source identity is never persisted. */
export function opaqueQuotaSignature(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function createQuotaHistoryScope(
  connectionScope: string,
  poolKey: string,
  contributorKeys: readonly string[]
): QuotaHistoryScope {
  const membershipSignature = opaqueQuotaSignature(
    [...contributorKeys].sort().join('\u0000')
  );
  const storageKey = `merged-quota-history-v2:${opaqueQuotaSignature(
    `${connectionScope}\u0000${poolKey}\u0000${membershipSignature}`
  )}`;
  return { storageKey, membershipSignature };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeHistoryPoint = (
  value: unknown,
  nowMs: number,
  expectedCapacityPercent?: number
): QuotaPoolHistoryPoint | null => {
  if (!isRecord(value)) return null;
  const atMs = value.atMs;
  const remainingPercent = value.remainingPercent;
  const capacityPercent = value.capacityPercent;
  if (
    typeof atMs !== 'number' ||
    !Number.isFinite(atMs) ||
    atMs < nowMs - QUOTA_HISTORY_MAX_AGE_MS ||
    atMs > nowMs + 60_000 ||
    typeof remainingPercent !== 'number' ||
    !Number.isFinite(remainingPercent) ||
    typeof capacityPercent !== 'number' ||
    !Number.isFinite(capacityPercent) ||
    capacityPercent <= 0 ||
    capacityPercent > MAX_QUOTA_HISTORY_ACCOUNTS * 100 ||
    remainingPercent < 0 ||
    remainingPercent > capacityPercent ||
    (expectedCapacityPercent !== undefined && capacityPercent !== expectedCapacityPercent)
  ) {
    return null;
  }

  const resetAtMs = Array.isArray(value.resetAtMs)
    ? value.resetAtMs
        .filter(
          (reset): reset is number =>
            typeof reset === 'number' && Number.isFinite(reset) && reset > atMs
        )
        .slice(0, MAX_QUOTA_HISTORY_ACCOUNTS)
        .sort((left, right) => left - right)
    : [];
  return { atMs, remainingPercent, capacityPercent, resetAtMs };
};

export function sanitizeQuotaPoolHistory(
  value: unknown,
  membershipSignature: string,
  nowMs = Date.now(),
  expectedCapacityPercent?: number
): QuotaPoolHistory {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.membershipSignature !== membershipSignature ||
    !Array.isArray(value.points)
  ) {
    return { membershipSignature, points: [] };
  }

  const points = value.points
    .flatMap((point): QuotaPoolHistoryPoint[] => {
      const sanitized = sanitizeHistoryPoint(point, nowMs, expectedCapacityPercent);
      return sanitized ? [sanitized] : [];
    })
    .sort((left, right) => left.atMs - right.atMs)
    .filter((point, index, all) => index === 0 || point.atMs > all[index - 1].atMs)
    .slice(-QUOTA_HISTORY_MAX_POINTS);
  return { membershipSignature, points };
}

export function readQuotaPoolHistory(
  storage: QuotaPoolHistoryStorage | null,
  storageKey: string,
  membershipSignature: string,
  nowMs = Date.now(),
  expectedCapacityPercent?: number
): QuotaPoolHistory {
  if (!storage) return { membershipSignature, points: [] };
  try {
    const raw = storage.getItem(storageKey);
    return raw
      ? sanitizeQuotaPoolHistory(
          JSON.parse(raw) as unknown,
          membershipSignature,
          nowMs,
          expectedCapacityPercent
        )
      : { membershipSignature, points: [] };
  } catch {
    return { membershipSignature, points: [] };
  }
}

export function writeQuotaPoolHistory(
  storage: QuotaPoolHistoryStorage | null,
  storageKey: string,
  history: QuotaPoolHistory
): void {
  if (!storage) return;
  try {
    const sanitized = sanitizeQuotaPoolHistory(
      { version: 1, ...history },
      history.membershipSignature
    );
    storage.setItem(storageKey, JSON.stringify({ version: 1, ...sanitized }));
  } catch {
    // Browser storage can be disabled or full; in-memory rendering still works.
  }
}

export function appendQuotaPoolHistory(
  history: QuotaPoolHistory,
  membershipSignature: string,
  point: QuotaPoolHistoryPoint,
  nowMs = point.atMs
): QuotaPoolHistory {
  const current = sanitizeQuotaPoolHistory(
    { version: 1, ...history },
    membershipSignature,
    nowMs,
    point.capacityPercent
  );
  const next = sanitizeHistoryPoint(point, nowMs, point.capacityPercent);
  const last = current.points[current.points.length - 1];
  if (!next || (last && next.atMs <= last.atMs)) return current;
  return {
    membershipSignature,
    points: [...current.points, next].slice(-QUOTA_HISTORY_MAX_POINTS),
  };
}

const hasResetBetween = (point: QuotaPoolHistoryPoint, nextAtMs: number): boolean =>
  point.resetAtMs.some((resetAtMs) => resetAtMs > point.atMs && resetAtMs <= nextAtMs);

export function inferPooledBurnRate(
  history: QuotaPoolHistory,
  membershipSignature: string,
  capacityPercent: number,
  nowMs = Date.now()
): number | null {
  if (
    history.membershipSignature !== membershipSignature ||
    history.points.length < MIN_BURN_SAMPLES
  ) {
    return null;
  }
  const points = history.points.filter(
    (point) =>
      point.atMs >= nowMs - QUOTA_HISTORY_MAX_AGE_MS &&
      point.atMs <= nowMs &&
      point.capacityPercent === capacityPercent
  );
  if (points.length < MIN_BURN_SAMPLES) return null;

  let firstIndex = points.length - 1;
  for (let index = points.length - 1; index > 0; index -= 1) {
    const older = points[index - 1];
    const newer = points[index];
    if (
      newer.atMs - older.atMs > MAX_BURN_GAP_MS ||
      hasResetBetween(older, newer.atMs) ||
      newer.remainingPercent > older.remainingPercent
    ) {
      break;
    }
    firstIndex = index - 1;
  }

  const comparable = points.slice(firstIndex);
  if (comparable.length < MIN_BURN_SAMPLES) return null;
  const first = comparable[0];
  const last = comparable[comparable.length - 1];
  const spanMs = last.atMs - first.atMs;
  if (spanMs < MIN_BURN_SPAN_MS) return null;
  const rate = ((first.remainingPercent - last.remainingPercent) / spanMs) * 60 * 60 * 1000;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function projectPooledQuota(
  contributors: readonly PooledQuotaContributor[],
  history: QuotaPoolHistory,
  membershipSignature: string,
  nowMs = Date.now()
): PooledQuotaProjection {
  const pool = summarizePooledQuota(contributors);
  const current = pool.remainingPercent;
  const capacity = pool.capacityPercent;
  const burnRatePercentPerHour = inferPooledBurnRate(
    history,
    membershipSignature,
    capacity,
    nowMs
  );
  const events = new Map<number, number>();
  pool.contributors.forEach((contributor) => {
    const resetAtMs = contributor.resetAtMs;
    if (resetAtMs === null || resetAtMs <= nowMs) return;
    const amount = Math.max(0, 100 - contributor.remainingPercent);
    events.set(resetAtMs, (events.get(resetAtMs) ?? 0) + amount);
  });
  const resets = Array.from(events.entries())
    .sort(([left], [right]) => left - right)
    .map(([atMs, increase]) => ({ atMs, increase }));
  const nextResetAtMs = resets[0]?.atMs ?? null;
  const noForecast = burnRatePercentPerHour === null && resets.length === 0;
  if (capacity === 0 || noForecast) {
    return {
      points: [{ atMs: nowMs, remainingPercent: current, reset: false }],
      burnRatePercentPerHour,
      nextResetAtMs,
      poolEmptyAtMs: current === 0 && capacity > 0 ? nowMs : null,
      resetOnly: burnRatePercentPerHour === null && resets.length > 0,
    };
  }

  const lastResetAtMs = resets[resets.length - 1]?.atMs ?? nowMs;
  const sixHoursAfterNow = nowMs + 6 * 60 * 60 * 1000;
  const sixHoursAfterLastReset = lastResetAtMs + 6 * 60 * 60 * 1000;
  const maxAtMs = nowMs + MAX_QUOTA_FORECAST_MS;
  const rate = burnRatePercentPerHour ?? 0;
  const predictedEmptyAtMs =
    rate > 0 ? nowMs + (current / rate) * 60 * 60 * 1000 : nowMs;
  const horizon = Math.min(
    maxAtMs,
    Math.max(
      sixHoursAfterNow,
      resets.length > 0 ? sixHoursAfterLastReset : sixHoursAfterNow,
      predictedEmptyAtMs
    )
  );
  const points: PooledQuotaProjectionPoint[] = [
    { atMs: nowMs, remainingPercent: current, reset: false },
  ];
  let atMs = nowMs;
  let remaining = current;
  let poolEmptyAtMs: number | null = current === 0 ? nowMs : null;

  resets
    .filter((event) => event.atMs <= horizon)
    .forEach((event) => {
      if (rate > 0 && remaining > 0) {
        const emptyAtMs = atMs + (remaining / rate) * 60 * 60 * 1000;
        if (emptyAtMs <= event.atMs) {
          if (poolEmptyAtMs === null) poolEmptyAtMs = emptyAtMs;
          points.push({ atMs: emptyAtMs, remainingPercent: 0, reset: false });
          remaining = 0;
          atMs = emptyAtMs;
        }
      }
      const beforeReset = Math.max(
        0,
        remaining - (rate * (event.atMs - atMs)) / (60 * 60 * 1000)
      );
      if (event.atMs > atMs) {
        points.push({ atMs: event.atMs, remainingPercent: beforeReset, reset: false });
      }
      remaining = Math.min(capacity, beforeReset + event.increase);
      points.push({ atMs: event.atMs, remainingPercent: remaining, reset: true });
      atMs = event.atMs;
    });

  if (atMs < horizon) {
    if (rate > 0 && remaining > 0) {
      const emptyAtMs = atMs + (remaining / rate) * 60 * 60 * 1000;
      if (emptyAtMs <= horizon) {
        if (poolEmptyAtMs === null) poolEmptyAtMs = emptyAtMs;
        points.push({ atMs: emptyAtMs, remainingPercent: 0, reset: false });
      } else {
        points.push({
          atMs: horizon,
          remainingPercent: Math.max(
            0,
            remaining - (rate * (horizon - atMs)) / (60 * 60 * 1000)
          ),
          reset: false,
        });
      }
    } else {
      points.push({ atMs: horizon, remainingPercent: remaining, reset: false });
    }
  }

  return {
    points,
    burnRatePercentPerHour,
    nextResetAtMs,
    poolEmptyAtMs,
    resetOnly: burnRatePercentPerHour === null,
  };
}

export interface MergedQuotaSession {
  requestId: number;
  cacheGeneration: number;
  connectionRevision: number;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const accountIdentity = (account: AggregateAntigravityAccount): string =>
  `${account.name}\u0000${account.email ?? ''}`;

const bucketIdentity = (
  group: AggregateQuotaGroup,
  bucket: AggregateQuotaBucket
): string | null => {
  const bucketId = bucket.bucketId?.trim() || '';
  const window = bucket.window?.trim() || '';
  const identity = bucketId || window;
  if (!identity) return null;
  return JSON.stringify([group.displayName, identity, window]);
};

export const getAntigravityBucketKey = bucketIdentity;

const bucketLabel = (bucket: AggregateQuotaBucket): string =>
  bucket.bucketId?.trim() || bucket.window?.trim() || 'Quota';

export function summarizeAntigravityBuckets(
  accounts: readonly AggregateAntigravityAccount[]
): AntigravityBucketSummary[] {
  const buckets = new Map<
    string,
    {
      groupDisplayName: string;
      bucketLabel: string;
      window: string | null;
      accounts: Map<string, number | null>;
    }
  >();

  accounts.forEach((account) => {
    if (account.disabled || account.error) return;
    const identity = accountIdentity(account);
    account.groups.forEach((group) => {
      group.buckets.forEach((bucket) => {
        const key = bucketIdentity(group, bucket);
        if (!key) return;
        const existing = buckets.get(key) ?? {
          groupDisplayName: group.displayName,
          bucketLabel: bucketLabel(bucket),
          window: bucket.window ?? null,
          accounts: new Map<string, number | null>(),
        };
        if (!existing.accounts.has(identity)) {
          existing.accounts.set(identity, bucket.remainingFraction);
        }
        buckets.set(key, existing);
      });
    });
  });

  return Array.from(buckets.entries())
    .map(([key, item]) => {
      const fractions = Array.from(item.accounts.values()).filter(
        (fraction): fraction is number =>
          typeof fraction === 'number' &&
          Number.isFinite(fraction) &&
          fraction >= 0 &&
          fraction <= 1
      );
      const exposed = item.accounts.size;
      const capacity = fractions.length;
      const remainingFractionSum = fractions.reduce((sum, fraction) => sum + fraction, 0);
      const coverage = fractions.length;
      return {
        key,
        groupDisplayName: item.groupDisplayName,
        bucketLabel: item.bucketLabel,
        window: item.window,
        remainingFractionSum,
        capacity,
        coverage,
        exposed,
        unknown: exposed - coverage,
        remainingPercent:
          capacity > 0 ? clampPercent((remainingFractionSum / capacity) * 100) : null,
      };
    })
    .sort(
      (left, right) =>
        left.groupDisplayName.localeCompare(right.groupDisplayName) ||
        left.bucketLabel.localeCompare(right.bucketLabel) ||
        (left.window ?? '').localeCompare(right.window ?? '')
    );
}

export function minimumAntigravityGroupFraction(
  account: AggregateAntigravityAccount,
  groupDisplayName: string
): number | null {
  if (account.disabled || account.error) return null;
  const group = account.groups.find((item) => item.displayName === groupDisplayName);
  if (!group || group.buckets.length === 0) return null;
  if (group.buckets.some((bucket) => bucket.remainingFraction === null)) return null;
  return Math.min(...group.buckets.map((bucket) => bucket.remainingFraction ?? 0));
}

export function mergedQuotaWindowKey(
  provider: QuotaProviderType,
  scope: string,
  limitId: string,
  unit: string,
  periodHours: number | null
): string {
  return JSON.stringify([provider, scope, limitId, unit, periodHours]);
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readPercent = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value;
};

const readPeriodHours = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readResetAtMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const makeWindow = (
  provider: QuotaProviderType,
  scope: string,
  limitId: string,
  label: string,
  periodHours: number | null,
  remainingPercent: number | null,
  unit = 'remaining-percent',
  labelKey?: string,
  labelParams?: Record<string, string | number>,
  resetAtMs: number | null = null
): MergedQuotaWindow => ({
  key: mergedQuotaWindowKey(provider, scope, limitId, unit, periodHours),
  label: label || limitId,
  ...(labelKey ? { labelKey } : {}),
  ...(labelParams ? { labelParams } : {}),
  remainingPercent,
  periodHours,
  resetAtMs,
});

const projectPercentWindows = (
  provider: QuotaProviderType,
  state: Record<string, unknown>
): MergedQuotaWindow[] => {
  if (!Array.isArray(state.windows)) return [];
  return state.windows.flatMap((item): MergedQuotaWindow[] => {
    const window = toRecord(item);
    if (!window) return [];
    const id = readText(window.id);
    if (!id) return [];
    const usedPercent = readPercent(window.usedPercent);
    const remainingPercent = usedPercent === null ? null : 100 - usedPercent;
    const periodHours = readPeriodHours(window.periodHours);
    const label = readText(window.labelKey) || readText(window.label) || id;
    const params = toRecord(window.labelParams);
    const labelParams = params
      ? Object.fromEntries(
          Object.entries(params).filter(
            (item): item is [string, string | number] =>
              typeof item[1] === 'string' || typeof item[1] === 'number'
          )
        )
      : undefined;
    return [
      makeWindow(
        provider,
        '',
        id,
        label,
        periodHours,
        remainingPercent,
        'remaining-percent',
        readText(window.labelKey) || undefined,
        labelParams,
        readResetAtMs(window.resetAtMs)
      ),
    ];
  });
};

/** Project only comparable quota windows from the existing adapter state shapes. */
export function projectStoredQuotaWindows(
  provider: QuotaProviderType,
  file: AuthFileItem,
  rawState: unknown
): MergedQuotaWindow[] {
  const state = toRecord(rawState);
  if (!state || state.status !== 'success') return [];

  if (provider === 'codex' || provider === 'claude') {
    return projectPercentWindows(provider, state);
  }

  if (provider === 'devin') {
    if (!Array.isArray(state.windows)) return [];
    return state.windows.flatMap((item): MergedQuotaWindow[] => {
      const window = toRecord(item);
      if (!window) return [];
      const id = readText(window.id);
      if (!id) return [];
      return [
        makeWindow(
          provider,
          '',
          id,
          readText(window.label) || id,
          readPeriodHours(window.periodHours),
          readPercent(window.remainingPercent),
          'remaining-percent',
          undefined,
          undefined,
          readResetAtMs(window.resetAtMs)
        ),
      ];
    });
  }

  if (provider === 'kimi') {
    if (!Array.isArray(state.rows)) return [];
    return state.rows.flatMap((item): MergedQuotaWindow[] => {
      const row = toRecord(item);
      if (!row) return [];
      const id = readText(row.id);
      if (!id) return [];
      const label = readText(row.label) || readText(row.labelKey) || id;
      const periodHours = readPeriodHours(row.periodHours);
      const limit = typeof row.limit === 'number' ? row.limit : Number(row.limit);
      const used = typeof row.used === 'number' ? row.used : Number(row.used);
      const validUsage = Number.isFinite(limit) && limit > 0 && Number.isFinite(used);
      const remainingPercent = validUsage ? clampPercent(((limit - used) / limit) * 100) : null;
      const labelKey = readText(row.labelKey) || undefined;
      const canAggregate =
        Boolean(row.label) || Boolean(labelKey && labelKey !== 'kimi_quota.limit_index');
      const scope = canAggregate ? label : `${file.name}:${label}`;
      const rawParams = toRecord(row.labelParams);
      const labelParams = rawParams
        ? Object.fromEntries(
            Object.entries(rawParams).filter(
              (item): item is [string, string | number] =>
                typeof item[1] === 'string' || typeof item[1] === 'number'
            )
          )
        : undefined;
      return [
        makeWindow(
          provider,
          scope,
          id,
          label,
          periodHours,
          remainingPercent,
          'remaining-percent',
          labelKey,
          labelParams,
          readResetAtMs(row.resetAtMs)
        ),
      ];
    });
  }

  if (provider === 'meta') {
    const data = toRecord(state.data);
    if (!data || !Array.isArray(data.windows)) return [];
    return data.windows.flatMap((item): MergedQuotaWindow[] => {
      const window = toRecord(item);
      if (!window) return [];
      const id = readText(window.id);
      if (!id) return [];
      const durationMinutes =
        typeof window.durationMinutes === 'number' ? window.durationMinutes : null;
      const periodHours = readPeriodHours(
        durationMinutes !== null ? durationMinutes / 60 : id === 'weekly' ? 168 : null
      );
      const usedPercent = readPercent(window.usedPercent);
      return [
        makeWindow(
          provider,
          '',
          id,
          id,
          periodHours,
          usedPercent === null ? null : 100 - usedPercent,
          'remaining-percent',
          undefined,
          undefined,
          typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
            ? window.resetAt * 1000
            : null
        ),
      ];
    });
  }

  if (provider === 'xai') {
    const billing = toRecord(state.billing);
    if (!billing || billing.mode !== 'billing' || billing.periodType !== 'weekly') return [];
    const usedPercent = readPercent(billing.usagePercent);
    return [
      makeWindow(
        provider,
        'weekly-billing-quota',
        'weekly',
        'weekly',
        readPeriodHours(billing.periodHours) ?? 168,
        usedPercent === null ? null : 100 - usedPercent,
        'remaining-percent',
        undefined,
        undefined,
        readResetAtMs(billing.resetAtMs)
      ),
    ];
  }

  if (provider === 'plugin') {
    if (!Array.isArray(state.groups)) return [];
    const pluginScope = readText(file.quotaPluginId) || readText(file.quotaProvider) || 'plugin';
    return state.groups.flatMap((item): MergedQuotaWindow[] => {
      const group = toRecord(item);
      if (!group || !Array.isArray(group.buckets)) return [];
      const groupLabel = readText(group.label) || readText(group.id) || 'group';
      return group.buckets.flatMap((bucketItem): MergedQuotaWindow[] => {
        const bucket = toRecord(bucketItem);
        if (!bucket) return [];
        const id = readText(bucket.id) || readText(bucket.window);
        if (!id) return [];
        const fraction =
          typeof bucket.remainingFraction === 'number' &&
          Number.isFinite(bucket.remainingFraction) &&
          bucket.remainingFraction >= 0 &&
          bucket.remainingFraction <= 1
            ? bucket.remainingFraction
            : null;
        return [
          makeWindow(
            provider,
            `${pluginScope}:${groupLabel}:${readText(bucket.window)}`,
            id,
            `${groupLabel} · ${readText(bucket.label) || id}`,
            readPeriodHours(bucket.periodHours),
            fraction === null ? null : fraction * 100,
            'remaining-percent',
            undefined,
            undefined,
            readResetAtMs(bucket.resetAtMs)
          ),
        ];
      });
    });
  }

  return [];
}

export function isMergedQuotaSessionCurrent(
  captured: MergedQuotaSession,
  current: MergedQuotaSession
): boolean {
  return (
    captured.requestId === current.requestId &&
    captured.cacheGeneration === current.cacheGeneration &&
    captured.connectionRevision === current.connectionRevision
  );
}
