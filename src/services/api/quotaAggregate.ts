import { apiClient } from './client';

export interface AggregateQuotaBucket {
  bucketId?: string;
  window?: string;
  resetTime?: string;
  remainingFraction: number | null;
}

export interface AggregateQuotaGroup {
  displayName: string;
  description?: string;
  buckets: AggregateQuotaBucket[];
}

export interface AggregateAntigravityAccount {
  name: string;
  email?: string;
  disabled: boolean;
  plan: string | null;
  groups: AggregateQuotaGroup[];
  error?: string;
  planError?: string;
}

export interface AggregateCodexAccount {
  name: string;
  email?: string;
  disabled: boolean;
  plan: string | null;
  signals: Record<string, string>;
  modelQuotas: Record<string, { signals: Record<string, string> }>;
}

export interface QuotaAggregateResponse {
  generated: string;
  antigravity: AggregateAntigravityAccount[];
  codex: AggregateCodexAccount[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readFraction = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;

const CODEX_SCALAR_SIGNALS = new Set([
  'active-limit',
  'plan-type',
  'credits-has-credits',
  'credits-unlimited',
  'credits-balance',
  'allowed',
  'limit-reached',
  'limit-name',
  'reset-after-seconds',
  'reset-after',
  'reset-at',
  'over-secondary-limit-percent',
]);

const CODEX_WINDOW_NAMES = [
  'primary',
  'secondary',
  'code-review-primary',
  'code-review-secondary',
];

const CODEX_WINDOW_FIELDS = new Set([
  'allowed',
  'limit-reached',
  'limit-name',
  'used-percent',
  'window-minutes',
  'reset-after-seconds',
  'reset-at',
  'over-secondary-limit-percent',
]);

const CODEX_NAMED_SUFFIXES = new Set([
  'allowed',
  'limit-reached',
  'limit-name',
  'over-secondary-limit-percent',
]);

const isValidCodexQuotaNamespace = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('-') &&
  !value.endsWith('-') &&
  /^[a-z0-9._-]+$/.test(value);

const isCodexQuotaSignal = (key: string): boolean => {
  const normalized = key.trim().toLowerCase();
  if (!normalized.startsWith('x-codex-')) return false;
  const name = normalized.slice('x-codex-'.length);
  if (CODEX_SCALAR_SIGNALS.has(name)) return true;

  for (const window of CODEX_WINDOW_NAMES) {
    const prefix = `${window}-`;
    if (name.startsWith(prefix) && CODEX_WINDOW_FIELDS.has(name.slice(prefix.length))) {
      return true;
    }
  }

  for (const marker of ['-primary-', '-secondary-']) {
    const index = name.indexOf(marker);
    if (index <= 0) continue;
    const namespace = name.slice(0, index);
    const field = name.slice(index + marker.length);
    if (isValidCodexQuotaNamespace(namespace) && CODEX_WINDOW_FIELDS.has(field)) {
      return true;
    }
  }

  for (const field of CODEX_NAMED_SUFFIXES) {
    const suffix = `-${field}`;
    if (!name.endsWith(suffix)) continue;
    return isValidCodexQuotaNamespace(name.slice(0, -suffix.length));
  }
  return false;
};

const readSignals = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const signals: Record<string, string> = {};
  for (const [key, signal] of Object.entries(value)) {
    if (isCodexQuotaSignal(key) && typeof signal === 'string') {
      signals[key] = signal;
    }
  }
  return signals;
};

const normalizeAntigravityAccount = (value: unknown): AggregateAntigravityAccount | null => {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  if (!name) return null;

  const groups = Array.isArray(value.groups)
    ? value.groups.flatMap((group): AggregateQuotaGroup[] => {
        if (!isRecord(group)) return [];
        const displayName = readString(group.displayName);
        if (!displayName) return [];
        const buckets = Array.isArray(group.buckets)
          ? group.buckets.flatMap((bucket): AggregateQuotaBucket[] => {
              if (!isRecord(bucket)) return [];
              const bucketId = readString(bucket.bucketId);
              const window = readString(bucket.window);
              const resetTime = readString(bucket.resetTime);
              return [
                {
                  ...(bucketId ? { bucketId } : {}),
                  ...(window ? { window } : {}),
                  ...(resetTime ? { resetTime } : {}),
                  remainingFraction: readFraction(bucket.remainingFraction),
                },
              ];
            })
          : [];
        const description = readString(group.description);
        return [{ displayName, ...(description ? { description } : {}), buckets }];
      })
    : [];

  return {
    name,
    ...(readString(value.email) ? { email: readString(value.email) } : {}),
    disabled: value.disabled === true,
    plan: readString(value.plan) ?? null,
    groups,
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
    ...(readString(value.plan_error) ? { planError: readString(value.plan_error) } : {}),
  };
};

const normalizeCodexAccount = (value: unknown): AggregateCodexAccount | null => {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  if (!name) return null;

  const quota = isRecord(value.quota) ? value.quota : {};
  const rawModelQuotas = isRecord(value.model_quotas) ? value.model_quotas : {};
  const modelQuotas = Object.fromEntries(
    Object.entries(rawModelQuotas).flatMap(([model, rawQuota]) => {
      if (!isRecord(rawQuota)) return [];
      return [[model, { signals: readSignals(rawQuota.signals) }] as const];
    })
  );

  return {
    name,
    ...(readString(value.email) ? { email: readString(value.email) } : {}),
    disabled: value.disabled === true,
    plan: readString(value.plan) ?? null,
    signals: readSignals(quota.signals),
    modelQuotas,
  };
};

/** Keep the UI boundary narrow: only backend-allowlisted Codex quota signals survive. */
export function normalizeQuotaAggregate(value: unknown): QuotaAggregateResponse {
  if (
    !isRecord(value) ||
    typeof value.generated !== 'string' ||
    !Array.isArray(value.antigravity) ||
    !Array.isArray(value.codex)
  ) {
    throw new Error('Invalid aggregate quota response');
  }

  return {
    generated: value.generated,
    antigravity: value.antigravity.flatMap((account) => {
      const normalized = normalizeAntigravityAccount(account);
      return normalized ? [normalized] : [];
    }),
    codex: value.codex.flatMap((account) => {
      const normalized = normalizeCodexAccount(account);
      return normalized ? [normalized] : [];
    }),
  };
}

type ApiGet = typeof apiClient.get;

export async function fetchQuotaAggregate(
  refresh = false,
  get: ApiGet = apiClient.get.bind(apiClient)
): Promise<QuotaAggregateResponse> {
  const path = refresh ? '/quota/aggregate?refresh=true' : '/quota/aggregate';
  return normalizeQuotaAggregate(await get<unknown>(path));
}
