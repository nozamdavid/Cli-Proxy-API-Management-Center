import type { QuotaProviderType } from './providers/types';
import { opaqueQuotaSignature } from './mergedQuota';

export type QuotaPoolSelections = Partial<Record<QuotaProviderType, string>>;

export interface QuotaPoolSelectionStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface QuotaPoolSelectionStore {
  read: (scope: string) => QuotaPoolSelections;
  write: (scope: string, provider: QuotaProviderType, selectionId: string) => void;
}

const STORAGE_PREFIX = 'merged-quota-pool-selection-v1:';
const VERSION = 1;
const OPAQUE_ID = /^[a-f0-9]{16}$/;
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
export const getQuotaPoolSelectionId = (poolKey: string): string => opaqueQuotaSignature(poolKey);

const DEFAULT_GEMINI_WEEKLY_POOL_ID = getQuotaPoolSelectionId(
  `antigravity:${JSON.stringify(['Gemini Models', 'gemini-weekly', 'weekly'])}`
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeSelections = (value: unknown): QuotaPoolSelections | null => {
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    !isRecord(value.selections)
  ) {
    return null;
  }
  const selections: QuotaPoolSelections = {};
  Object.entries(value.selections).forEach(([provider, selectionId]) => {
    if (
      PROVIDERS.includes(provider as QuotaProviderType) &&
      typeof selectionId === 'string' &&
      OPAQUE_ID.test(selectionId)
    ) {
      selections[provider as QuotaProviderType] = selectionId;
    }
  });
  return selections;
};

export const createQuotaPoolSelectionStore = (
  storage: QuotaPoolSelectionStorage | null
): QuotaPoolSelectionStore => {
  const memory = new Map<string, QuotaPoolSelections>();
  const read = (scope: string): QuotaPoolSelections => {
    if (!OPAQUE_ID.test(scope)) return {};
    const inMemory = memory.get(scope) ?? {};
    try {
      const raw = storage?.getItem(`${STORAGE_PREFIX}${scope}`);
      if (raw) {
        const persisted = sanitizeSelections(JSON.parse(raw));
        if (persisted) {
          const selections = { ...inMemory, ...persisted };
          memory.set(scope, selections);
          return { ...selections };
        }
      }
    } catch {
      // Browser storage may be unavailable or contain corrupt data.
    }
    return { ...inMemory };
  };

  return {
    read,
    write(scope, provider, selectionId) {
      if (!OPAQUE_ID.test(scope) || !OPAQUE_ID.test(selectionId)) return;
      const selections = { ...read(scope), [provider]: selectionId };
      memory.set(scope, selections);
      try {
        storage?.setItem(
          `${STORAGE_PREFIX}${scope}`,
          JSON.stringify({ version: VERSION, selections })
        );
      } catch {
        // Keep the explicit selection in memory when browser storage fails.
      }
    },
  };
};

export const quotaPoolSelectionStore = createQuotaPoolSelectionStore((() => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
})());

export interface SelectableQuotaPool {
  selectionId: string;
}

export function resolveQuotaPoolSelection<T extends SelectableQuotaPool>(
  pools: readonly T[],
  provider: QuotaProviderType,
  savedSelectionId?: string
): T | null {
  return (
    pools.find((pool) => pool.selectionId === savedSelectionId) ??
    (provider === 'antigravity'
      ? pools.find((pool) => pool.selectionId === DEFAULT_GEMINI_WEEKLY_POOL_ID)
      : undefined) ??
    pools[0] ??
    null
  );
}
