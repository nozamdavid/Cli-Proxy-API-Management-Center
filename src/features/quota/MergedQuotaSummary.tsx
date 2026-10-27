import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { fetchQuotaAggregate } from '@/services/api/quotaAggregate';
import { apiClient } from '@/services/api/client';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useAuthStore,
  useQuotaStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  buildAntigravityQuotaGroups,
  isDisabledAuthFile,
  isPaidXaiAuthFile,
} from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type {
  AggregateAntigravityAccount,
  AggregateCodexAccount,
  QuotaAggregateResponse,
} from '@/services/api/quotaAggregate';
import { normalizeApiBase } from '@/utils/connection';
import { ANTIGRAVITY_CONFIG } from './providers/antigravity/data';
import {
  QUOTA_ADAPTERS,
  getQuotaMap,
  getQuotaSetter,
  type QuotaCardState,
} from './providers';
import { PooledQuotaChart, type PooledQuotaPoolView } from './PooledQuotaChart';
import type { QuotaProviderType } from './providers/types';
import type { QuotaFileEntry } from './logic';
import { resolveQuotaProviderType } from './logic';
import {
  appendQuotaPoolHistory,
  createQuotaHistoryScope,
  getAntigravityBucketKey,
  isMergedQuotaSessionCurrent,
  minimumAntigravityGroupFraction,
  opaqueQuotaSignature,
  projectPooledQuota,
  projectStoredQuotaWindows,
  representativeQuotaObservationTime,
  retainQuotaPoolHistories,
  readQuotaPoolHistory,
  summarizePooledQuota,
  writeQuotaPoolHistory,
  type QuotaPoolHistory,
  type QuotaPoolHistoryStorage,
  type MergedQuotaSession,
  type MergedQuotaWindow,
} from './mergedQuota';
import {
  createQuotaGraphCacheScope,
  quotaGraphCache,
  writeQuotaGraphSnapshotIfSuccessful,
  type QuotaGraphSnapshot,
  type QuotaGraphSnapshotProjection,
  type QuotaGraphSnapshotPool,
} from './graphCache';
import {
  getQuotaPoolSelectionId,
  quotaPoolSelectionStore,
  resolveQuotaPoolSelection,
  type QuotaPoolSelections,
} from './poolSelection';
import {
  normalizeQuotaGraphColor,
  quotaGraphColorPreferenceStore,
  type QuotaGraphColors,
} from './graphColorPreferences';
import styles from './MergedQuotaSummary.module.scss';

const AUTO_REFRESH_MS = 120_000;
const BATCH_CONCURRENCY = 4;
const CLOCK_REFRESH_MS = 60_000;
const INITIAL_NOW_MS = Date.now();

interface MergedQuotaSummaryProps {
  files: AuthFileItem[];
  entries: QuotaFileEntry[];
  ready: boolean;
  listError: boolean;
  batchLoading: boolean;
  loadQuota: (targets: QuotaFileEntry[], maxConcurrent?: number) => Promise<boolean>;
}

interface DisplayEntry extends QuotaFileEntry {
  disabled: boolean;
}

interface AntigravityDisplayRow {
  account: AggregateAntigravityAccount;
  file?: AuthFileItem;
  missing: boolean;
}

interface CodexDisplayRow {
  account: AggregateCodexAccount;
  file?: AuthFileItem;
  missing: boolean;
}

interface WindowColumn {
  key: string;
  label: string;
  periodHours: number | null;
  values: Map<string, MergedQuotaWindow>;
}

interface PoolObservation {
  key: string;
  label: string;
  provider: QuotaProviderType;
  periodHours: number | null;
  exposed: Map<string, { remainingPercent: number | null; resetAtMs: number | null }>;
  eligibleCount: number;
  disabledCount: number;
}

interface FreshQuotaObservation {
  id: number;
  cacheGeneration: number;
  connectionRevision: number;
  observationTimes: Map<string, number>;
  successful: boolean;
}

interface StoredPoolHistory {
  storageKey: string;
  membershipSignature: string;
  connectionSignature: string;
  lastUsedAtMs: number;
  history: QuotaPoolHistory;
}

const providerLabels: Record<QuotaProviderType, { key: string; fallback: string }> = {
  antigravity: { key: 'antigravity_quota.title', fallback: 'Antigravity' },
  claude: { key: 'claude_quota.title', fallback: 'Claude' },
  codex: { key: 'codex_quota.title', fallback: 'Codex' },
  devin: { key: 'devin_quota.title', fallback: 'Devin' },
  kimi: { key: 'kimi_quota.title', fallback: 'Kimi' },
  meta: { key: 'meta_quota.title', fallback: 'Muse (Meta)' },
  plugin: { key: 'plugin_quota.title', fallback: 'Plugin quota' },
  xai: { key: 'xai_quota.title', fallback: 'Grok' },
};

const signalPriority = (key: string): number => {
  const normalized = key.toLowerCase();
  if (normalized.includes('active')) return 0;
  if (normalized.includes('limit')) return 1;
  if (normalized.includes('credit')) return 2;
  if (normalized.includes('reset')) return 3;
  return 4;
};

const sortSignalKeys = (keys: string[]): string[] =>
  [...keys].sort(
    (left, right) =>
      signalPriority(left) - signalPriority(right) || left.localeCompare(right)
  );

const formatPercent = (value: number, language: string): string =>
  `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)}%`;

const getQuotaHistoryStorage = (): QuotaPoolHistoryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const makeUnavailableAccount = (
  file: AuthFileItem,
  disabled: boolean
): AggregateAntigravityAccount => ({
  name: file.name,
  ...(file.email ? { email: file.email } : {}),
  disabled,
  plan: null,
  groups: [],
});

const makeUnavailableCodexAccount = (
  file: AuthFileItem,
  disabled: boolean
): AggregateCodexAccount => ({
  name: file.name,
  ...(file.email ? { email: file.email } : {}),
  disabled,
  plan: null,
  signals: {},
  modelQuotas: {},
});

function Meter({
  label,
  percent,
  language,
  unavailable,
}: {
  label: string;
  percent: number | null;
  language: string;
  unavailable: string;
}) {
  if (percent === null || !Number.isFinite(percent)) {
    return (
      <span className={styles.unavailable} role="status">
        {unavailable}
      </span>
    );
  }

  const value = Math.max(0, Math.min(100, percent));
  const formatted = formatPercent(value, language);
  return (
    <div className={styles.meterCell}>
      <div
        className={styles.meter}
        role="meter"
        aria-label={`${label}: ${formatted}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <span className={styles.meterFill} style={{ width: `${value}%` }} />
      </div>
      <span className={styles.meterValue}>{formatted}</span>
    </div>
  );
}

export function MergedQuotaSummary({
  files,
  entries,
  ready,
  listError,
  batchLoading,
  loadQuota,
}: MergedQuotaSummaryProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || 'en';
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const cacheGeneration = useQuotaStore((state) => state.cacheGeneration);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const connectionRevision = apiClient.getConnectionRevision();
  const graphCacheScope = createQuotaGraphCacheScope(normalizeApiBase(apiBase), managementKey);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [graphSnapshotState, setGraphSnapshotState] = useState<{
    scope: string;
    connectionRevision: number;
    snapshot: QuotaGraphSnapshot | null;
  }>(() => ({
    scope: graphCacheScope,
    connectionRevision,
    snapshot: graphCacheScope ? quotaGraphCache.read(graphCacheScope) : null,
  }));
  const graphSnapshotForScope = useMemo(() => {
    if (
      graphSnapshotState.scope === graphCacheScope &&
      graphSnapshotState.connectionRevision === connectionRevision
    ) {
      return graphSnapshotState.snapshot;
    }
    return graphCacheScope ? quotaGraphCache.read(graphCacheScope) : null;
  }, [connectionRevision, graphCacheScope, graphSnapshotState]);
  const [summaryResult, setSummaryResult] = useState<{
    cacheGeneration: number;
    connectionRevision: number;
    data: QuotaAggregateResponse | null;
    error: boolean;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [graphRefreshErrorState, setGraphRefreshErrorState] = useState<{
    scope: string;
    connectionRevision: number;
    error: boolean;
  }>(() => ({ scope: graphCacheScope, connectionRevision, error: false }));
  const graphRefreshError =
    graphRefreshErrorState.scope === graphCacheScope &&
    graphRefreshErrorState.connectionRevision === connectionRevision &&
    graphRefreshErrorState.error;
  const [pendingRefresh, setPendingRefresh] = useState(false);
  const [poolSelectionState, setPoolSelectionState] = useState<{
    scope: string;
    selections: QuotaPoolSelections;
  }>(() => ({
    scope: graphCacheScope,
    selections: graphCacheScope ? quotaPoolSelectionStore.read(graphCacheScope) : {},
  }));
  const poolSelections =
    poolSelectionState.scope === graphCacheScope
      ? poolSelectionState.selections
      : graphCacheScope
        ? quotaPoolSelectionStore.read(graphCacheScope)
        : {};
  const [graphColorState, setGraphColorState] = useState<{
    scope: string;
    colors: QuotaGraphColors;
  }>(() => ({
    scope: graphCacheScope,
    colors: graphCacheScope ? quotaGraphColorPreferenceStore.read(graphCacheScope) : {},
  }));
  const graphColors =
    graphColorState.scope === graphCacheScope
      ? graphColorState.colors
      : graphCacheScope
        ? quotaGraphColorPreferenceStore.read(graphCacheScope)
        : {};
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);
  const [freshObservation, setFreshObservation] = useState<FreshQuotaObservation | null>(null);
  const [historyByPool, setHistoryByPool] = useState<Record<string, StoredPoolHistory>>({});
  // Wake queued work even when an invalidated request finishes after refreshing was already cleared.
  const [refreshCompletion, setRefreshCompletion] = useState(0);
  const refreshingRef = useRef(false);
  const refreshingRequestRef = useRef<number | null>(null);
  const batchLoadingRef = useRef(batchLoading);
  const requestIdRef = useRef(0);
  const capturedObservationRef = useRef<number | null>(null);
  const capturedGraphSnapshotRef = useRef<number | null>(null);
  const historyByPoolRef = useRef(historyByPool);
  const lastAggregateObservationRef = useRef<{
    cacheGeneration: number;
    connectionRevision: number;
    generated: string;
  } | null>(null);

  const currentSummaryResult =
    summaryResult?.cacheGeneration === cacheGeneration &&
    summaryResult?.connectionRevision === connectionRevision
      ? summaryResult
      : null;
  const aggregate = currentSummaryResult?.data ?? null;
  const aggregateError = currentSummaryResult?.error ?? false;

  useEffect(() => {
    batchLoadingRef.current = batchLoading;
  }, [batchLoading]);

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, CLOCK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () => ({
      antigravity: antigravityQuota,
      claude: claudeQuota,
      codex: codexQuota,
      devin: devinQuota,
      kimi: kimiQuota,
      meta: metaQuota,
      plugin: pluginQuota,
      xai: xaiQuota,
    }),
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const displayEntries = useMemo<DisplayEntry[]>(
    () =>
      (ready ? files : []).flatMap((file) => {
        const type = resolveQuotaProviderType({ ...file, disabled: false });
        return type ? [{ file, type, disabled: isDisabledAuthFile(file) }] : [];
      }),
    [files, ready]
  );

  const unsupportedFiles = useMemo(
    () =>
      (ready ? files : []).filter(
        (file) => !resolveQuotaProviderType({ ...file, disabled: false })
      ),
    [files, ready]
  );

  const applyAntigravityAggregate = useCallback(
    (
      accounts: NonNullable<typeof aggregate>['antigravity'],
      activeEntries: QuotaFileEntry[],
      captured: MergedQuotaSession,
      fileGenerations: Map<string, ReturnType<typeof captureQuotaCacheGeneration>>
    ) => {
      const accountsByName = new Map(accounts.map((account) => [account.name, account]));
      const adapter = QUOTA_ADAPTERS.antigravity;
      const setQuota = getQuotaSetter(adapter);

      activeEntries
        .filter((entry) => entry.type === 'antigravity')
        .forEach(({ file }) => {
          const generation = fileGenerations.get(file.name);
          if (!generation || generation.cacheGeneration !== captured.cacheGeneration) return;
          const account = accountsByName.get(file.name);
          let nextState: QuotaCardState;
          if (!account || account.disabled) {
            nextState = adapter.buildErrorState(
              t('quota_management.merged_unavailable', { defaultValue: 'Quota unavailable' })
            );
          } else if (account.error) {
            nextState = adapter.buildErrorState(account.error);
          } else {
            const groups = buildAntigravityQuotaGroups({ groups: account.groups });
            nextState = ANTIGRAVITY_CONFIG.buildSuccessState({
              groups,
              subscription: account.plan
                ? { plan: account.plan, tierName: null, tierId: null }
                : null,
              serverTimeOffsetMs: null,
            });
          }
          commitIfQuotaCacheCurrent(generation, () => {
            setQuota((prev) => ({ ...prev, [getQuotaCacheKey(file)]: nextState }));
          });
        });
    },
    [t]
  );

  const applyAntigravityFailure = useCallback(
    (
      activeEntries: QuotaFileEntry[],
      captured: MergedQuotaSession,
      fileGenerations: Map<string, ReturnType<typeof captureQuotaCacheGeneration>>,
      message: string
    ) => {
      const adapter = QUOTA_ADAPTERS.antigravity;
      const setQuota = getQuotaSetter(adapter);
      activeEntries
        .filter((entry) => entry.type === 'antigravity')
        .forEach(({ file }) => {
          const generation = fileGenerations.get(file.name);
          if (!generation || generation.cacheGeneration !== captured.cacheGeneration) return;
          commitIfQuotaCacheCurrent(generation, () => {
            setQuota((prev) => ({
              ...prev,
              [getQuotaCacheKey(file)]: adapter.buildErrorState(message),
            }));
          });
        });
    },
    []
  );

  const refreshSummary = useCallback(
    async (force: boolean) => {
      if (!ready || connectionStatus !== 'connected') return;
      if (refreshingRef.current || batchLoadingRef.current) {
        setPendingRefresh(true);
        return;
      }

      setPendingRefresh(false);
      refreshingRef.current = true;
      setRefreshing(true);
      const requestId = ++requestIdRef.current;
      refreshingRequestRef.current = requestId;
      const captured: MergedQuotaSession = {
        requestId,
        cacheGeneration: useQuotaStore.getState().cacheGeneration,
        connectionRevision: apiClient.getConnectionRevision(),
      };
      const currentSession = (): MergedQuotaSession => ({
        requestId: requestIdRef.current,
        cacheGeneration: useQuotaStore.getState().cacheGeneration,
        connectionRevision: apiClient.getConnectionRevision(),
      });
      const isCurrent = () => isMergedQuotaSessionCurrent(captured, currentSession());
      const pinnedClient = apiClient.captureConnection();
      const nonAntigravityEntries = entries.filter(
        (entry) =>
          entry.type !== 'antigravity' &&
          !(entry.type === 'xai' && isPaidXaiAuthFile(entry.file))
      );
      const previousAdapterStates = new Map<string, QuotaCardState | undefined>();
      nonAntigravityEntries.forEach(({ type, file }) => {
        const cacheKey = getQuotaCacheKey(file);
        previousAdapterStates.set(
          `${type}:${cacheKey}`,
          getQuotaMap(QUOTA_ADAPTERS[type])[cacheKey]
        );
      });
      const antigravityGenerations = new Map<
        string,
        ReturnType<typeof captureQuotaCacheGeneration>
      >(
        entries
          .filter((entry) => entry.type === 'antigravity')
          .map(({ file }) => [file.name, captureQuotaCacheGeneration(file.name)] as const)
      );
      let aggregateFresh = false;

      try {
        const aggregateRequest = fetchQuotaAggregate(
          force,
          pinnedClient.get.bind(pinnedClient)
        ).then(
          (data) => {
            if (isCurrent()) {
              const previous = lastAggregateObservationRef.current;
              aggregateFresh =
                previous === null ||
                previous.cacheGeneration !== captured.cacheGeneration ||
                previous.connectionRevision !== captured.connectionRevision ||
                previous.generated !== data.generated;
              lastAggregateObservationRef.current = {
                cacheGeneration: captured.cacheGeneration,
                connectionRevision: captured.connectionRevision,
                generated: data.generated,
              };
              setSummaryResult({
                cacheGeneration: captured.cacheGeneration,
                connectionRevision: captured.connectionRevision,
                data,
                error: false,
              });
              applyAntigravityAggregate(
                data.antigravity,
                entries,
                captured,
                antigravityGenerations
              );
            }
            return data;
          },
          (error: unknown) => {
            if (isCurrent()) {
              setSummaryResult({
                cacheGeneration: captured.cacheGeneration,
                connectionRevision: captured.connectionRevision,
                data: null,
                error: true,
              });
              applyAntigravityFailure(
                entries,
                captured,
                antigravityGenerations,
                t('quota_management.merged_unavailable', {
                  defaultValue: 'Quota unavailable',
                })
              );
            }
            throw error;
          }
        );
        const [aggregateResult, adapterResult] = await Promise.allSettled([
          aggregateRequest,
          loadQuota(nonAntigravityEntries, BATCH_CONCURRENCY),
        ]);

        if (!isCurrent()) return;

        const freshObservationTimes = new Map<string, number>();
        if (aggregateResult.status === 'fulfilled' && aggregateFresh) {
          const generatedAtMs = Date.parse(aggregateResult.value.generated);
          if (Number.isFinite(generatedAtMs)) {
            aggregateResult.value.antigravity.forEach((account) => {
              const localEntry = displayEntries.find(
                (entry) => entry.type === 'antigravity' && entry.file.name === account.name
              );
              freshObservationTimes.set(
                `antigravity:${localEntry ? getQuotaCacheKey(localEntry.file) : account.name}`,
                generatedAtMs
              );
            });
          }
        }
        if (adapterResult.status === 'fulfilled' && adapterResult.value) {
          nonAntigravityEntries.forEach(({ type, file }) => {
            const cacheKey = getQuotaCacheKey(file);
            const contributorKey = `${type}:${cacheKey}`;
            const state = getQuotaMap(QUOTA_ADAPTERS[type])[cacheKey];
            if (
              state?.status === 'success' &&
              state !== previousAdapterStates.get(contributorKey) &&
              typeof state.mergedObservedAtMs === 'number' &&
              Number.isFinite(state.mergedObservedAtMs)
            ) {
              freshObservationTimes.set(contributorKey, state.mergedObservedAtMs);
            }
          });
        }

        const aggregateData =
          aggregateResult.status === 'fulfilled' ? aggregateResult.value : null;
        const aggregateSucceeded = Boolean(
          aggregateData &&
            aggregateData.antigravity.every((account) => account.disabled || !account.error) &&
            entries
              .filter((entry) => entry.type === 'antigravity' && !isDisabledAuthFile(entry.file))
              .every(({ file }) => {
                const account = aggregateData.antigravity.find(
                  (candidate) => candidate.name === file.name
                );
                return Boolean(account && !account.disabled && !account.error);
              })
        );
        const adapterSucceeded =
          nonAntigravityEntries.length === 0 ||
          (adapterResult.status === 'fulfilled' &&
            adapterResult.value &&
            nonAntigravityEntries.every(({ type, file }) =>
              getQuotaMap(QUOTA_ADAPTERS[type])[getQuotaCacheKey(file)]?.status === 'success'
            ));
        const refreshSucceeded = aggregateSucceeded && adapterSucceeded;
        setGraphRefreshErrorState({
          scope: graphCacheScope,
          connectionRevision: captured.connectionRevision,
          error: !refreshSucceeded,
        });
        setFreshObservation({
          id: requestId,
          cacheGeneration: captured.cacheGeneration,
          connectionRevision: captured.connectionRevision,
          observationTimes: freshObservationTimes,
          successful: refreshSucceeded,
        });

        if (
          force &&
          (aggregateResult.status === 'rejected' || adapterResult.status === 'rejected')
        ) {
          showNotification(
            t('quota_management.merged_load_failed', {
              defaultValue: 'Some merged quota data could not be refreshed.',
            }),
            'error'
          );
        }
      } finally {
        if (refreshingRequestRef.current === requestId) {
          refreshingRequestRef.current = null;
          refreshingRef.current = false;
          setRefreshing(false);
          setRefreshCompletion((revision) => revision + 1);
        }
      }
    },
    [
      applyAntigravityAggregate,
      applyAntigravityFailure,
      connectionStatus,
      displayEntries,
      entries,
      graphCacheScope,
      loadQuota,
      ready,
      showNotification,
      t,
    ]
  );

  useEffect(() => {
    if (!ready || connectionStatus !== 'connected') {
      requestIdRef.current += 1;
      setRefreshing(false);
      setPendingRefresh(false);
      setSummaryResult(null);
      setFreshObservation(null);
      setHistoryByPool({});
      historyByPoolRef.current = {};
      capturedObservationRef.current = null;
      return;
    }

    void refreshSummary(false);
    const timer = window.setInterval(() => void refreshSummary(false), AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      requestIdRef.current += 1;
    };
  }, [cacheGeneration, connectionRevision, connectionStatus, ready, refreshSummary]);

  useEffect(() => {
    if (
      pendingRefresh &&
      !refreshing &&
      !refreshingRef.current &&
      !batchLoading &&
      ready
    ) {
      setPendingRefresh(false);
      void refreshSummary(false);
    }
  }, [
    batchLoading,
    pendingRefresh,
    ready,
    refreshCompletion,
    refreshSummary,
    refreshing,
  ]);

  const allAntigravityRows = useMemo<AntigravityDisplayRow[]>(() => {
    const localFiles = displayEntries.filter((entry) => entry.type === 'antigravity');
    const localByName = new Map(localFiles.map((entry) => [entry.file.name, entry]));
    const seen = new Set<string>();
    const rows = (aggregate?.antigravity ?? []).map((account) => {
      seen.add(account.name);
      return { account, file: localByName.get(account.name)?.file, missing: false };
    });
    localFiles.forEach(({ file, disabled }) => {
      if (seen.has(file.name)) return;
      rows.push({ account: makeUnavailableAccount(file, disabled), file, missing: true });
    });
    return rows;
  }, [aggregate, displayEntries]);

  const antigravityGroups = useMemo(
    () =>
      Array.from(
        new Set(
          allAntigravityRows.flatMap((row) => row.account.groups.map((group) => group.displayName))
        )
      ).sort((left, right) => left.localeCompare(right)),
    [allAntigravityRows]
  );

  const allCodexRows = useMemo<CodexDisplayRow[]>(() => {
    const localFiles = displayEntries.filter((entry) => entry.type === 'codex');
    const localByName = new Map(localFiles.map((entry) => [entry.file.name, entry]));
    const seen = new Set<string>();
    const rows = (aggregate?.codex ?? []).map((account) => {
      seen.add(account.name);
      return { account, file: localByName.get(account.name)?.file, missing: false };
    });
    localFiles.forEach(({ file, disabled }) => {
      if (seen.has(file.name)) return;
      rows.push({ account: makeUnavailableCodexAccount(file, disabled), file, missing: true });
    });
    return rows;
  }, [aggregate, displayEntries]);

  const codexSignalKeys = useMemo(
    () =>
      sortSignalKeys(
        Array.from(
          new Set(
            allCodexRows.flatMap((row) =>
              row.account.disabled ? [] : Object.keys(row.account.signals)
            )
          )
        )
      ),
    [allCodexRows]
  );

  const codexModelSignalKeys = useMemo(
    () =>
      sortSignalKeys(
        Array.from(
          new Set(
            allCodexRows.flatMap((row) =>
              row.account.disabled
                ? []
                : Object.values(row.account.modelQuotas).flatMap((quota) =>
                    Object.keys(quota.signals)
                  )
            )
          )
        )
      ),
    [allCodexRows]
  );

  const generatedLabel = useMemo(() => {
    if (!aggregate?.generated) return '';
    const time = Date.parse(aggregate.generated);
    return Number.isFinite(time)
      ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
      : aggregate.generated;
  }, [aggregate, language]);

  const unavailable = t('quota_management.merged_unavailable', {
    defaultValue: 'Unavailable',
  });
  const disabledLabel = t('quota_management.merged_disabled', { defaultValue: 'Disabled' });

  const getWindowLabel = useCallback(
    (window: MergedQuotaWindow, provider: QuotaProviderType): string => {
      if (window.labelKey) {
        return t(window.labelKey, {
          ...(window.labelParams ?? {}),
          defaultValue: window.label,
        });
      }
      if (provider === 'meta' && (window.label === 'window' || window.label === 'weekly')) {
        return t(`meta_quota.${window.label}`, { defaultValue: window.label });
      }
      return window.label;
    },
    [t]
  );

  const quotaPools = useMemo<PooledQuotaPoolView[]>(() => {
    const observations = new Map<string, PoolObservation>();
    const eligibleCounts = new Map<QuotaProviderType, number>();
    const disabledCounts = new Map<QuotaProviderType, number>();
    displayEntries.forEach(({ type, disabled }) => {
      const counts = disabled ? disabledCounts : eligibleCounts;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    });

    const addObservation = (
      key: string,
      label: string,
      provider: QuotaProviderType,
      periodHours: number | null,
      contributorKey: string,
      remainingPercent: number | null,
      resetAtMs: number | null,
      eligibleCount: number,
      disabledCount: number
    ) => {
      const observation = observations.get(key) ?? {
        key,
        label,
        provider,
        periodHours,
        exposed: new Map(),
        eligibleCount,
        disabledCount,
      };
      if (!observation.exposed.has(contributorKey)) {
        observation.exposed.set(contributorKey, { remainingPercent, resetAtMs });
      }
      observations.set(key, observation);
    };

    const antigravityEntries = new Map(
      displayEntries
        .filter((entry) => entry.type === 'antigravity')
        .map((entry) => [entry.file.name, entry])
    );
    const aggregateEligibleCount = (aggregate?.antigravity ?? []).filter((account) => {
      const localEntry = antigravityEntries.get(account.name);
      return !account.disabled && !localEntry?.disabled;
    }).length;
    const aggregateDisabledCount = (aggregate?.antigravity ?? []).filter((account) => {
      const localEntry = antigravityEntries.get(account.name);
      return account.disabled || localEntry?.disabled;
    }).length;
    const antigravityEligibleCount = Math.max(
      eligibleCounts.get('antigravity') ?? 0,
      aggregateEligibleCount
    );
    const antigravityDisabledCount = Math.max(
      disabledCounts.get('antigravity') ?? 0,
      aggregateDisabledCount
    );
    (aggregate?.antigravity ?? []).forEach((account) => {
      const localEntry = antigravityEntries.get(account.name);
      if (account.disabled || account.error || localEntry?.disabled) return;
      const file = localEntry?.file;
      const contributorKey = `antigravity:${file ? getQuotaCacheKey(file) : account.name}`;
      account.groups.forEach((group) => {
        group.buckets.forEach((bucket) => {
          const bucketKey = getAntigravityBucketKey(group, bucket);
          if (!bucketKey) return;
          const bucketLabel = bucket.bucketId?.trim() || bucket.window?.trim() || 'Quota';
          const label = `${group.displayName} · ${bucketLabel}${
            bucket.window && bucket.window !== bucketLabel ? ` · ${bucket.window}` : ''
          }`;
          const parsedReset = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
          const remainingPercent =
            typeof bucket.remainingFraction === 'number' &&
            Number.isFinite(bucket.remainingFraction) &&
            bucket.remainingFraction >= 0 &&
            bucket.remainingFraction <= 1
              ? bucket.remainingFraction * 100
              : null;
          addObservation(
            `antigravity:${bucketKey}`,
            label,
            'antigravity',
            null,
            contributorKey,
            remainingPercent,
            Number.isFinite(parsedReset) ? parsedReset : null,
            antigravityEligibleCount,
            antigravityDisabledCount
          );
        });
      });
    });

    displayEntries.forEach(({ file, type, disabled }) => {
      if (disabled || type === 'antigravity') return;
      const cacheKey = getQuotaCacheKey(file);
      const windows = projectStoredQuotaWindows(type, file, quotaByType[type][cacheKey]);
      windows.forEach((window) => {
        addObservation(
          window.key,
          getWindowLabel(window, type),
          type,
          window.periodHours,
          `${type}:${cacheKey}`,
          window.remainingPercent,
          window.resetAtMs,
          eligibleCounts.get(type) ?? 0,
          disabledCounts.get(type) ?? 0
        );
      });
    });

    return Array.from(observations.values())
      .map((observation) => {
        const summary = summarizePooledQuota(
          Array.from(observation.exposed.entries()).map(([key, value]) => ({ key, ...value }))
        );
        const providerName = t(providerLabels[observation.provider].key, {
          defaultValue: providerLabels[observation.provider].fallback,
        });
        const historyScope = createQuotaHistoryScope(
          graphCacheScope,
          observation.key,
          summary.contributors.map((contributor) => contributor.key)
        );
        const hours =
          observation.periodHours === null
            ? ''
            : ` · ${t('quota_management.merged_hours', {
                count: observation.periodHours,
                defaultValue: `${observation.periodHours}h`,
              })}`;
        return {
          ...summary,
          key: observation.key,
          selectionId: getQuotaPoolSelectionId(observation.key),
          label: observation.label,
          provider: observation.provider,
          periodHours: observation.periodHours,
          selectLabel: `${providerName} · ${observation.label}${hours}`,
          eligibleCount: observation.eligibleCount,
          exposedCount: observation.exposed.size,
          disabledCount: observation.disabledCount,
          membershipSignature: historyScope.membershipSignature,
          historyStorageKey: historyScope.storageKey,
        };
      })
      .sort(
        (left, right) =>
          left.selectLabel.localeCompare(right.selectLabel) || left.key.localeCompare(right.key)
      );
  }, [aggregate, displayEntries, getWindowLabel, graphCacheScope, quotaByType, t]);

  const availableQuotaPools = useMemo(
    () => quotaPools.filter((pool) => pool.contributors.length > 0),
    [quotaPools]
  );
  const cachedQuotaPools = useMemo<PooledQuotaPoolView[]>(() => {
    const snapshot = graphSnapshotForScope;
    if (
      !snapshot ||
      !graphCacheScope ||
      connectionStatus === 'disconnected'
    ) {
      return [];
    }

    const currentMembers = new Set<string>();
    const eligibleCounts = new Map<QuotaProviderType, number>();
    const disabledCounts = new Map<QuotaProviderType, number>();
    if (ready) {
      displayEntries.forEach(({ file, type, disabled }) => {
        if (disabled) {
          disabledCounts.set(type, (disabledCounts.get(type) ?? 0) + 1);
          return;
        }
        eligibleCounts.set(type, (eligibleCounts.get(type) ?? 0) + 1);
        currentMembers.add(opaqueQuotaSignature(`${type}:${getQuotaCacheKey(file)}`));
      });
    }

    return snapshot.pools.flatMap((cachedPool): PooledQuotaPoolView[] => {
      const contributors = ready
        ? cachedPool.contributors.filter((contributor) => currentMembers.has(contributor.id))
        : cachedPool.contributors;
      if (contributors.length === 0) return [];

      const membershipChanged = contributors.length !== cachedPool.contributors.length;
      const capacityPercent = contributors.length * 100;
      const cachedProjection =
        !membershipChanged &&
        capacityPercent === cachedPool.capacityPercent &&
        cachedPool.projection?.poolId === cachedPool.id &&
        cachedPool.projection.provider === cachedPool.provider &&
        cachedPool.projection.capacityPercent === capacityPercent &&
        cachedPool.projection.membershipSignature === cachedPool.membershipSignature
          ? cachedPool.projection
          : undefined;
      const remainingPercent = contributors.reduce(
        (sum, contributor) => sum + contributor.remainingPercent,
        0
      );
      const providerName = t(providerLabels[cachedPool.provider].key, {
        defaultValue: providerLabels[cachedPool.provider].fallback,
      });
      const hours =
        cachedPool.periodHours === null
          ? ''
          : ` · ${t('quota_management.merged_hours', {
              count: cachedPool.periodHours,
              defaultValue: `${cachedPool.periodHours}h`,
            })}`;
      const removedContributorCount = cachedPool.contributors.length - contributors.length;
      return [
        {
          contributors: contributors.map((contributor) => ({
            key: contributor.id,
            remainingPercent: contributor.remainingPercent,
            resetAtMs: contributor.resetAtMs,
          })),
          remainingPercent,
          capacityPercent,
          key: cachedPool.id,
          selectionId: cachedPool.id,
          label: cachedPool.label,
          provider: cachedPool.provider,
          periodHours: cachedPool.periodHours,
          selectLabel: `${providerName} · ${cachedPool.label}${hours}`,
          eligibleCount: ready
            ? (eligibleCounts.get(cachedPool.provider) ?? 0)
            : cachedPool.eligibleCount,
          exposedCount: ready
            ? Math.max(
                contributors.length,
                cachedPool.exposedCount - removedContributorCount
              )
            : cachedPool.exposedCount,
          disabledCount: ready
            ? (disabledCounts.get(cachedPool.provider) ?? 0)
            : cachedPool.disabledCount,
          membershipSignature: membershipChanged
            ? opaqueQuotaSignature(
                contributors
                  .map((contributor) => contributor.id)
                  .sort()
                  .join('\u0000')
              )
            : cachedPool.membershipSignature,
          historyStorageKey: membershipChanged ? '' : cachedPool.historyStorageKey,
          ...(cachedProjection ? { cachedProjection } : {}),
        },
      ];
    });
  }, [connectionStatus, displayEntries, graphCacheScope, graphSnapshotForScope, ready, t]);

  const hasSuccessfulLiveGraph = Boolean(
    freshObservation?.successful &&
      freshObservation.cacheGeneration === cacheGeneration &&
      freshObservation.connectionRevision === connectionRevision
  );
  const showingCachedGraph = Boolean(
    graphSnapshotForScope &&
      graphCacheScope &&
      connectionStatus !== 'disconnected' &&
      (!ready || refreshing || !hasSuccessfulLiveGraph)
  );
  const displayedQuotaPools = showingCachedGraph ? cachedQuotaPools : availableQuotaPools;

  const quotaPoolGroups = useMemo(() => {
    const groups = new Map<QuotaProviderType, PooledQuotaPoolView[]>();
    displayedQuotaPools.forEach((pool) => {
      const group = groups.get(pool.provider) ?? [];
      group.push(pool);
      groups.set(pool.provider, group);
    });
    return Array.from(groups.entries());
  }, [displayedQuotaPools]);
  const pooledChartViews = quotaPoolGroups.flatMap(([provider, pools]) => {
    const pool = resolveQuotaPoolSelection(pools, provider, poolSelections[provider]);
    if (!pool) return [];
    const storedHistory = historyByPool[pool.key];
    const loadedHistory =
      storedHistory?.membershipSignature === pool.membershipSignature &&
      storedHistory.storageKey === pool.historyStorageKey
        ? storedHistory.history
        : pool.historyStorageKey
          ? readQuotaPoolHistory(
              getQuotaHistoryStorage(),
              pool.historyStorageKey,
              pool.membershipSignature,
              nowMs,
              pool.capacityPercent
            )
          : { membershipSignature: pool.membershipSignature, points: [] };
    const observationAtMs =
      freshObservation &&
      hasSuccessfulLiveGraph &&
      freshObservation.cacheGeneration === cacheGeneration &&
      freshObservation.connectionRevision === connectionRevision &&
      pool.contributors.length > 0
        ? representativeQuotaObservationTime(
            pool.contributors.map(
              (contributor) =>
                freshObservation.observationTimes.get(contributor.key) ?? Number.NaN
            )
          )
        : null;
    return [
      {
        provider,
        pools,
        pool,
        history: loadedHistory,
        fresh: !showingCachedGraph && observationAtMs !== null,
        cached: showingCachedGraph,
        refreshing:
          refreshing ||
          connectionStatus === 'connecting' ||
          (!ready && !listError && connectionStatus === 'connected'),
        refreshFailed:
          graphRefreshError ||
          aggregateError ||
          listError ||
          connectionStatus === 'error',
        updatedAtMs: showingCachedGraph
          ? (graphSnapshotForScope?.pools.find((item) => item.id === pool.key)?.observedAtMs ?? null)
          : observationAtMs,
      },
    ];
  });

  useEffect(() => {
    const observation = freshObservation;
    if (
      !graphCacheScope ||
      !ready ||
      refreshing ||
      !observation?.successful ||
      observation.cacheGeneration !== cacheGeneration ||
      observation.connectionRevision !== connectionRevision ||
      capturedGraphSnapshotRef.current === observation.id
    ) {
      return;
    }
    const savedAtMs = Date.now();
    let historyReady = true;
    const pools: QuotaGraphSnapshotPool[] = availableQuotaPools.flatMap((pool) => {
      const observedAtMs = representativeQuotaObservationTime(
        pool.contributors.map(
          (contributor) => observation.observationTimes.get(contributor.key) ?? Number.NaN
        )
      );
      if (observedAtMs === null) return [];

      const historyScope = createQuotaHistoryScope(
        graphCacheScope,
        pool.key,
        pool.contributors.map((contributor) => contributor.key)
      );
      const storedHistory = historyByPool[pool.key];
      const history =
        storedHistory?.storageKey === historyScope.storageKey &&
        storedHistory.membershipSignature === historyScope.membershipSignature
          ? storedHistory.history
          : readQuotaPoolHistory(
              getQuotaHistoryStorage(),
              historyScope.storageKey,
              historyScope.membershipSignature,
              savedAtMs,
              pool.capacityPercent
            );
      const includesObservedPoint = history.points.some(
        (point) =>
          point.atMs === observedAtMs &&
          point.remainingPercent === pool.remainingPercent &&
          point.capacityPercent === pool.capacityPercent
      );
      if (!includesObservedPoint) {
        historyReady = false;
        return [];
      }
      const projection = projectPooledQuota(
        pool.contributors,
        history,
        pool.membershipSignature,
        nowMs
      );
      const projectionSnapshot: QuotaGraphSnapshotProjection = {
        poolId: opaqueQuotaSignature(pool.key),
        provider: pool.provider,
        capacityPercent: pool.capacityPercent,
        membershipSignature: pool.membershipSignature,
        generatedAtMs: nowMs,
        sourceObservedAtMs: observedAtMs,
        ...projection,
      };
      return [
        {
          id: opaqueQuotaSignature(pool.key),
          label: pool.label,
          provider: pool.provider,
          periodHours: pool.periodHours,
          eligibleCount: pool.eligibleCount,
          exposedCount: pool.exposedCount,
          disabledCount: pool.disabledCount,
          remainingPercent: pool.remainingPercent,
          capacityPercent: pool.capacityPercent,
          membershipSignature: pool.membershipSignature,
          historyStorageKey: pool.historyStorageKey,
          observedAtMs,
          contributors: pool.contributors.map((contributor) => ({
            id: opaqueQuotaSignature(contributor.key),
            remainingPercent: contributor.remainingPercent,
            resetAtMs: contributor.resetAtMs,
          })),
          projection: projectionSnapshot,
        },
      ];
    });
    if (!historyReady || pools.length !== availableQuotaPools.length) return;
    const snapshot = writeQuotaGraphSnapshotIfSuccessful(
      quotaGraphCache,
      graphCacheScope,
      { version: 1, savedAtMs, pools },
      true,
      savedAtMs
    );
    if (snapshot) {
      capturedGraphSnapshotRef.current = observation.id;
      setGraphSnapshotState({ scope: graphCacheScope, connectionRevision, snapshot });
    }
  }, [
    availableQuotaPools,
    cacheGeneration,
    connectionRevision,
    freshObservation,
    graphCacheScope,
    historyByPool,
    nowMs,
    ready,
    refreshing,
  ]);

  useEffect(() => {
    const storage = getQuotaHistoryStorage();
    const connectionSignature = graphCacheScope;
    const effectNowMs = Date.now();
    const shouldCapture =
      freshObservation !== null &&
      freshObservation.cacheGeneration === cacheGeneration &&
      freshObservation.connectionRevision === connectionRevision &&
      capturedObservationRef.current !== freshObservation.id;
    if (shouldCapture && freshObservation) capturedObservationRef.current = freshObservation.id;
    const nextHistories: Record<string, StoredPoolHistory> = {};

    availableQuotaPools.forEach((pool) => {
      const scope = createQuotaHistoryScope(
        graphCacheScope,
        pool.key,
        pool.contributors.map((contributor) => contributor.key)
      );
      const previous = historyByPoolRef.current[pool.key];
      const loaded = readQuotaPoolHistory(
        storage,
        scope.storageKey,
        scope.membershipSignature,
        effectNowMs,
        pool.capacityPercent
      );
      let history =
        loaded.points.length === 0 &&
        previous?.storageKey === scope.storageKey &&
        previous.membershipSignature === scope.membershipSignature &&
        previous.history.points.length > 0
          ? previous.history
          : loaded;

      const observationAtMs =
        freshObservation &&
        pool.contributors.length > 0 &&
        freshObservation.cacheGeneration === cacheGeneration &&
        freshObservation.connectionRevision === connectionRevision
          ? representativeQuotaObservationTime(
              pool.contributors.map(
                (contributor) =>
                  freshObservation.observationTimes.get(contributor.key) ?? Number.NaN
              )
            )
          : null;
      const hasFreshObservation =
        shouldCapture &&
        observationAtMs !== null;
      if (hasFreshObservation && observationAtMs !== null) {
        history = appendQuotaPoolHistory(
          history,
          scope.membershipSignature,
          {
            atMs: observationAtMs,
            remainingPercent: pool.remainingPercent,
            capacityPercent: pool.capacityPercent,
            resetAtMs: pool.contributors
              .map((contributor) => contributor.resetAtMs)
              .filter((resetAtMs): resetAtMs is number =>
                resetAtMs !== null && resetAtMs > observationAtMs
              ),
          },
          observationAtMs
        );
        writeQuotaPoolHistory(storage, scope.storageKey, history);
      }

      nextHistories[pool.key] = {
        storageKey: scope.storageKey,
        membershipSignature: scope.membershipSignature,
        connectionSignature,
        lastUsedAtMs: effectNowMs,
        history,
      };
    });

    const retainedHistories = retainQuotaPoolHistories(
      historyByPoolRef.current,
      nextHistories,
      connectionSignature
    );
    historyByPoolRef.current = retainedHistories;
    setHistoryByPool(retainedHistories);
  }, [availableQuotaPools, cacheGeneration, connectionRevision, freshObservation, graphCacheScope]);

  const renderProviderWindows = (provider: QuotaProviderType) => {
    const providerEntries = displayEntries.filter((entry) => entry.type === provider);
    if (provider === 'antigravity' || providerEntries.length === 0) return null;

    const columns = new Map<string, WindowColumn>();
    const windowsByAccount = new Map<string, MergedQuotaWindow[]>();
    providerEntries.forEach(({ file, disabled }) => {
      if (disabled) return;
      const cacheKey = getQuotaCacheKey(file);
      const state = quotaByType[provider][cacheKey];
      const windows = projectStoredQuotaWindows(provider, file, state);
      windowsByAccount.set(cacheKey, windows);
      windows.forEach((window) => {
        const column = columns.get(window.key) ?? {
          key: window.key,
          label: getWindowLabel(window, provider),
          periodHours: window.periodHours,
          values: new Map<string, MergedQuotaWindow>(),
        };
        column.values.set(cacheKey, window);
        columns.set(window.key, column);
      });
    });
    const sortedColumns = Array.from(columns.values()).sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        (left.periodHours ?? 0) - (right.periodHours ?? 0)
    );
    const summaryLabel = providerLabels[provider];

    return (
      <section className={styles.providerSection} key={provider}>
        <h3 className={styles.sectionTitle}>
          {t(summaryLabel.key, { defaultValue: summaryLabel.fallback })}
        </h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>
              {t('quota_management.merged_account_table', {
                provider: t(summaryLabel.key, { defaultValue: summaryLabel.fallback }),
                defaultValue: `${summaryLabel.fallback} quota by account`,
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {t('quota_management.merged_account', { defaultValue: 'Account' })}
                </th>
                {sortedColumns.map((column) => (
                  <th scope="col" key={column.key}>
                    {column.label}
                    {column.periodHours !== null && (
                      <small>
                        {t('quota_management.merged_hours', {
                          count: column.periodHours,
                          defaultValue: `${column.periodHours}h`,
                        })}
                      </small>
                    )}
                  </th>
                ))}
                <th scope="col">
                  {t('quota_management.merged_status', { defaultValue: 'Status' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {providerEntries.map(({ file, disabled }) => {
                const cacheKey = getQuotaCacheKey(file);
                const state = quotaByType[provider][cacheKey];
                const status = disabled
                  ? disabledLabel
                  : state?.status === 'loading'
                    ? t('quota_management.merged_loading', { defaultValue: 'Loading' })
                    : state?.status === 'success' &&
                        (windowsByAccount.get(cacheKey)?.length ?? 0) > 0
                      ? t('quota_management.merged_available', { defaultValue: 'Available' })
                      : unavailable;
                return (
                  <tr key={`${provider}:${cacheKey}`}>
                    <th scope="row">{getQuotaDisplayName(file)}</th>
                    {sortedColumns.map((column) => {
                      const window = windowsByAccount
                        .get(cacheKey)
                        ?.find((item) => item.key === column.key);
                      return (
                        <td key={column.key}>
                          {disabled ? (
                            disabledLabel
                          ) : (
                            <Meter
                              label={`${getQuotaDisplayName(file)} · ${column.label}`}
                              percent={window?.remainingPercent ?? null}
                              language={language}
                              unavailable={unavailable}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td>{status}</td>
                  </tr>
                );
              })}
              {providerEntries.length === 0 && (
                <tr>
                  <td colSpan={Math.max(2, sortedColumns.length + 2)}>{unavailable}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const formatAccount = (name: string, email: string | undefined, file?: AuthFileItem) =>
    file ? getQuotaDisplayName(file) : email ? `${name} · ${email}` : name;

  const unsupportedProvider = (file: AuthFileItem): string => {
    const provider = String(file.provider ?? file.type ?? '').trim().replace(/[-_]/g, ' ');
    return (
      provider ||
      t('quota_management.merged_other_provider', { defaultValue: 'Other provider' })
    );
  };

  return (
    <section
      className={styles.summary}
      aria-labelledby="merged-quota-title"
      aria-busy={refreshing}
    >
      <header className={styles.summaryHeader}>
        <div>
          <h2 id="merged-quota-title" className={styles.summaryTitle}>
            {t('quota_management.merged_title', { defaultValue: 'Merged quota summary' })}
          </h2>
          <p className={styles.summaryMeta}>
            {generatedLabel
              ? t('quota_management.merged_generated', {
                  time: generatedLabel,
                  defaultValue: `Updated ${generatedLabel}`,
                })
              : refreshing
                ? t('quota_management.merged_loading', { defaultValue: 'Loading quota data' })
                : unavailable}
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void refreshSummary(true)}
          disabled={!ready || refreshing || batchLoading}
          aria-label={t('quota_management.merged_refresh', { defaultValue: 'Refresh now' })}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          {refreshing
            ? t('quota_management.merged_refreshing', { defaultValue: 'Refreshing' })
            : t('quota_management.merged_refresh', { defaultValue: 'Refresh now' })}
        </button>
      </header>

      {aggregateError && (
        <p className={styles.error} role="alert">
          {t('quota_management.merged_load_failed', {
            defaultValue: 'Aggregate quota data is unavailable.',
          })}
        </p>
      )}

      {pooledChartViews.length > 0 ? (
        pooledChartViews.map(
          ({
            provider,
            pools,
            pool,
            history,
            fresh,
            cached,
            refreshing: graphRefreshing,
            refreshFailed,
            updatedAtMs,
          }) => (
            <PooledQuotaChart
              key={provider}
              providerName={t(providerLabels[provider].key, {
                defaultValue: providerLabels[provider].fallback,
              })}
              pools={pools}
              pool={pool}
              history={history}
              selectedPoolKey={pool.selectionId}
              onSelectPool={(selectionId) => {
                if (!graphCacheScope) return;
                quotaPoolSelectionStore.write(graphCacheScope, provider, selectionId);
                setPoolSelectionState({
                  scope: graphCacheScope,
                  selections: { ...poolSelections, [provider]: selectionId },
                });
              }}
              nowMs={nowMs}
              fresh={fresh}
              cached={cached}
              refreshing={graphRefreshing}
              refreshFailed={refreshFailed}
              updatedAtMs={updatedAtMs}
              language={language}
              graphColor={graphColors[provider] ?? null}
              onChangeGraphColor={(value) => {
                const color = normalizeQuotaGraphColor(value);
                if (!graphCacheScope || !color) return;
                quotaGraphColorPreferenceStore.set(graphCacheScope, provider, color);
                setGraphColorState({
                  scope: graphCacheScope,
                  colors: { ...graphColors, [provider]: color },
                });
              }}
              onResetGraphColor={() => {
                if (!graphCacheScope) return;
                quotaGraphColorPreferenceStore.reset(graphCacheScope, provider);
                const colors = { ...graphColors };
                delete colors[provider];
                setGraphColorState({ scope: graphCacheScope, colors });
              }}
            />
          )
        )
      ) : (
        <p className={styles.empty} role="status">
          {t('quota_management.merged_no_pools', {
            defaultValue: 'No quota windows are available yet.',
          })}
        </p>
      )}

      <section className={styles.providerSection} aria-labelledby="merged-antigravity-title">
        <h3 id="merged-antigravity-title" className={styles.sectionTitle}>
          {t(providerLabels.antigravity.key, { defaultValue: providerLabels.antigravity.fallback })}
        </h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>
              {t('quota_management.merged_antigravity_table', {
                defaultValue: 'Antigravity quota by account and group',
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {t('quota_management.merged_account', { defaultValue: 'Account' })}
                </th>
                <th scope="col">{t('quota_management.merged_plan', { defaultValue: 'Plan' })}</th>
                {antigravityGroups.map((group) => (
                  <th scope="col" key={group}>
                    {group}
                    <small>
                      {t('quota_management.merged_group_min', {
                        defaultValue: 'Minimum by group',
                      })}
                    </small>
                  </th>
                ))}
                <th scope="col">
                  {t('quota_management.merged_status', { defaultValue: 'Status' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {allAntigravityRows.map(({ account, file, missing }) => {
                const status = account.disabled
                  ? disabledLabel
                  : account.error || missing
                    ? unavailable
                    : t('quota_management.merged_available', { defaultValue: 'Available' });
                return (
                  <tr key={`antigravity:${account.name}:${account.email ?? ''}`}>
                    <th scope="row">{formatAccount(account.name, account.email, file)}</th>
                    <td>
                      {account.disabled
                        ? disabledLabel
                        : account.plan || unavailable}
                      {account.planError && (
                        <small className={styles.rowError}>{account.planError}</small>
                      )}
                    </td>
                    {antigravityGroups.map((group) => {
                      const fraction = minimumAntigravityGroupFraction(account, group);
                      return (
                        <td key={group}>
                          {account.disabled ? (
                            disabledLabel
                          ) : (
                            <Meter
                              label={`${formatAccount(
                                account.name,
                                account.email,
                                file
                              )} · ${group}`}
                              percent={fraction === null ? null : fraction * 100}
                              language={language}
                              unavailable={unavailable}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <span>{status}</span>
                      {account.error && <small className={styles.rowError}>{account.error}</small>}
                      {missing && !account.disabled && <small>{unavailable}</small>}
                    </td>
                  </tr>
                );
              })}
              {allAntigravityRows.length === 0 && (
                <tr>
                  <td colSpan={Math.max(3, antigravityGroups.length + 3)}>{unavailable}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {renderProviderWindows('codex')}

      <section className={styles.providerSection} aria-labelledby="merged-codex-title">
        <h3 id="merged-codex-title" className={styles.sectionTitle}>
          {t(providerLabels.codex.key, { defaultValue: providerLabels.codex.fallback })} ·{' '}
          {t('quota_management.merged_signals', { defaultValue: 'quota signals' })}
        </h3>
        {codexSignalKeys.length === 0 && (
          <p className={styles.empty} role="status">
            {t('quota_management.merged_signals_unavailable', {
              defaultValue: 'Codex quota signals are unavailable.',
            })}
          </p>
        )}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>
              {t('quota_management.merged_codex_signals_table', {
                defaultValue: 'Codex quota signals by account',
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {t('quota_management.merged_account', { defaultValue: 'Account' })}
                </th>
                <th scope="col">{t('quota_management.merged_plan', { defaultValue: 'Plan' })}</th>
                {codexSignalKeys.map((key) => (
                  <th scope="col" key={key}>{key}</th>
                ))}
                <th scope="col">
                  {t('quota_management.merged_status', { defaultValue: 'Status' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {allCodexRows.map(({ account, file, missing }) => (
                <tr key={`codex:${account.name}`}>
                  <th scope="row">{formatAccount(account.name, account.email, file)}</th>
                  <td>{account.disabled ? disabledLabel : account.plan || unavailable}</td>
                  {codexSignalKeys.map((key) => (
                    <td key={key}>
                      {account.disabled ? disabledLabel : account.signals[key] || unavailable}
                    </td>
                  ))}
                  <td>
                    {account.disabled
                      ? disabledLabel
                      : missing
                        ? unavailable
                        : codexSignalKeys.length > 0 && Object.keys(account.signals).length > 0
                          ? t('quota_management.merged_available', { defaultValue: 'Available' })
                          : unavailable}
                  </td>
                </tr>
              ))}
              {allCodexRows.length === 0 && (
                <tr>
                  <td colSpan={Math.max(3, codexSignalKeys.length + 3)}>{unavailable}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h4 className={styles.subsectionTitle}>
          {t('quota_management.merged_model_quotas', { defaultValue: 'Model quotas' })}
        </h4>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>
              {t('quota_management.merged_codex_models_table', {
                defaultValue: 'Codex model quotas by account',
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {t('quota_management.merged_account', { defaultValue: 'Account' })}
                </th>
                <th scope="col">{t('quota_management.merged_model', { defaultValue: 'Model' })}</th>
                {codexModelSignalKeys.length > 0 ? (
                  codexModelSignalKeys.map((key) => (
                    <th scope="col" key={key}>{key}</th>
                  ))
                ) : (
                  <th scope="col">
                    {t('quota_management.merged_signals', { defaultValue: 'Quota signals' })}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {allCodexRows.flatMap(({ account, file }) =>
                Object.entries(account.modelQuotas).map(([model, quota]) => (
                  <tr key={`${account.name}:${model}`}>
                    <th scope="row">{formatAccount(account.name, account.email, file)}</th>
                    <td>{model}</td>
                    {codexModelSignalKeys.length > 0 ? (
                      codexModelSignalKeys.map((key) => (
                        <td key={key}>
                          {account.disabled ? disabledLabel : quota.signals[key] || unavailable}
                        </td>
                      ))
                    ) : (
                      <td>{account.disabled ? disabledLabel : unavailable}</td>
                    )}
                  </tr>
                ))
              )}
              {!allCodexRows.some((row) => Object.keys(row.account.modelQuotas).length > 0) && (
                <tr>
                  <td colSpan={Math.max(3, codexModelSignalKeys.length + 2)}>{unavailable}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(['claude', 'devin', 'kimi', 'meta', 'xai', 'plugin'] as const).map((provider) =>
        renderProviderWindows(provider)
      )}

      {unsupportedFiles.length > 0 && (
        <section className={styles.providerSection}>
          <h3 className={styles.sectionTitle}>
            {t('quota_management.merged_other_providers', { defaultValue: 'Other providers' })}
          </h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>
                {t('quota_management.merged_unavailable_table', {
                  defaultValue: 'Accounts without a quota adapter',
                })}
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    {t('quota_management.merged_account', { defaultValue: 'Account' })}
                  </th>
                  <th scope="col">
                    {t('quota_management.merged_provider', { defaultValue: 'Provider' })}
                  </th>
                  <th scope="col">
                    {t('quota_management.merged_status', { defaultValue: 'Status' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {unsupportedFiles.map((file) => (
                  <tr key={`unsupported:${file.name}`}>
                    <th scope="row">{getQuotaDisplayName(file)}</th>
                    <td>{unsupportedProvider(file)}</td>
                    <td>{isDisabledAuthFile(file) ? disabledLabel : unavailable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}

