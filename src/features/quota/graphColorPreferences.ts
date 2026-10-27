import type { QuotaProviderType } from './providers/types';

export type QuotaGraphColors = Partial<Record<QuotaProviderType, string>>;

export interface QuotaGraphColorStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface QuotaGraphColorPreferenceStore {
  read: (scope: string) => QuotaGraphColors;
  set: (scope: string, provider: QuotaProviderType, color: unknown) => void;
  reset: (scope: string, provider: QuotaProviderType) => void;
}

export const DEFAULT_GRAPH_PICKER_COLOR = '#10b981';

const STORAGE_PREFIX = 'merged-quota-graph-colors-v1:';
const VERSION = 1;
const OPAQUE_ID = /^[a-f0-9]{16}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
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

export const normalizeQuotaGraphColor = (value: unknown): string | null =>
  typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeColors = (value: unknown): QuotaGraphColors | null => {
  if (!isRecord(value) || value.version !== VERSION || !isRecord(value.colors)) return null;
  const colors: QuotaGraphColors = {};
  Object.entries(value.colors).forEach(([provider, color]) => {
    const normalized = normalizeQuotaGraphColor(color);
    if (PROVIDERS.includes(provider as QuotaProviderType) && normalized) {
      colors[provider as QuotaProviderType] = normalized;
    }
  });
  return colors;
};

export const createQuotaGraphColorPreferenceStore = (
  storage: QuotaGraphColorStorage | null
): QuotaGraphColorPreferenceStore => {
  const memory = new Map<string, QuotaGraphColors>();
  const storageKey = (scope: string) => `${STORAGE_PREFIX}${scope}`;
  const read = (scope: string): QuotaGraphColors => {
    if (!OPAQUE_ID.test(scope)) return {};
    const inMemory = memory.get(scope) ?? {};
    try {
      const raw = storage?.getItem(storageKey(scope));
      if (raw) {
        const persisted = sanitizeColors(JSON.parse(raw));
        if (persisted) {
          const colors = { ...inMemory, ...persisted };
          memory.set(scope, colors);
          return { ...colors };
        }
      }
    } catch {
      // Browser storage may be unavailable or contain corrupt data.
    }
    return { ...inMemory };
  };
  const persist = (scope: string, colors: QuotaGraphColors) => {
    memory.set(scope, colors);
    try {
      if (Object.keys(colors).length === 0) storage?.removeItem(storageKey(scope));
      else storage?.setItem(storageKey(scope), JSON.stringify({ version: VERSION, colors }));
    } catch {
      // Keep preferences in memory when browser storage fails.
    }
  };

  return {
    read,
    set(scope, provider, color) {
      const normalized = normalizeQuotaGraphColor(color);
      if (!OPAQUE_ID.test(scope) || !normalized) return;
      persist(scope, { ...read(scope), [provider]: normalized });
    },
    reset(scope, provider) {
      if (!OPAQUE_ID.test(scope)) return;
      const colors = read(scope);
      delete colors[provider];
      persist(scope, colors);
    },
  };
};

const browserStorage = (): QuotaGraphColorStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const quotaGraphColorPreferenceStore = createQuotaGraphColorPreferenceStore(
  browserStorage()
);
