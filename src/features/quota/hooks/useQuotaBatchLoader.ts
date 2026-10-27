/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 全局最多四个凭证并发，完成的凭证立即提交。
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import {
  QUOTA_ADAPTERS,
  getQuotaMap,
  getQuotaSetter,
  type QuotaCardState,
} from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import type { QuotaProviderType } from '../providers/types';

interface BatchFetchResult {
  cacheKey: string;
  status: 'success' | 'error';
  data?: unknown;
  observedAtMs?: number;
  error?: string;
  errorStatus?: number;
}

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (targets: QuotaFileEntry[], maxConcurrent = 4): Promise<boolean> => {
      if (loadingRef.current || targets.length === 0) return false;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      setBatchLoading(true);

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const adapter = QUOTA_ADAPTERS[entry.type];
          if (getQuotaMap(adapter)[getQuotaCacheKey(entry.file)]?.status === 'loading') return;
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        if (groups.size === 0) return false;

        const loadingStates = new Map<string, QuotaCardState>();
        const tasks = Array.from(groups.entries()).flatMap(([type, entries]) => {
          const adapter = QUOTA_ADAPTERS[type];
          const setQuota = getQuotaSetter(adapter);
          const generationByKey = new Map<string, ReturnType<typeof captureQuotaCacheGeneration>>();
          entries.forEach(({ file }) => {
            const cacheKey = getQuotaCacheKey(file);
            generationByKey.set(cacheKey, captureQuotaCacheGeneration(file.name));
          });

          commitIfQuotaCacheCurrent(captureQuotaCacheGeneration(), () => {
            setQuota((prev) => {
              const nextState = { ...prev };
              entries.forEach(({ file }) => {
                const cacheKey = getQuotaCacheKey(file);
                nextState[cacheKey] = adapter.buildLoadingState();
              });
              return nextState;
            });
          });

          entries.forEach(({ file }) => {
            const cacheKey = getQuotaCacheKey(file);
            const state = getQuotaMap(adapter)[cacheKey];
            if (state) loadingStates.set(`${type}:${cacheKey}`, state);
          });

          return entries.map((entry) => ({
            entry,
            adapter,
            setQuota,
            generation: generationByKey.get(getQuotaCacheKey(entry.file)),
            expectedLoadingState: loadingStates.get(`${type}:${getQuotaCacheKey(entry.file)}`),
          }));
        });

        let nextTask = 0;
        const concurrency = Math.max(1, Math.min(4, Math.floor(maxConcurrent) || 4));
        await Promise.all(
          Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
            while (nextTask < tasks.length) {
              const task = tasks[nextTask++];
              const { entry, adapter, setQuota, generation, expectedLoadingState } = task;
              const { file } = entry;
              const cacheKey = getQuotaCacheKey(file);
              if (!generation || !expectedLoadingState || requestId !== requestIdRef.current) {
                continue;
              }

              let result: BatchFetchResult;
              try {
                const data = await adapter.fetchQuota(file, t);
                result = { cacheKey, status: 'success', data, observedAtMs: Date.now() };
              } catch (err: unknown) {
                result = {
                  cacheKey,
                  status: 'error',
                  error: err instanceof Error ? err.message : t('common.unknown_error'),
                  errorStatus: getStatusFromError(err),
                };
              }

              if (requestId !== requestIdRef.current) continue;
              let committedState: QuotaCardState | undefined;
              commitIfQuotaCacheCurrent(generation, () => {
                setQuota((prev) => {
                  if (prev[cacheKey] !== expectedLoadingState) return prev;
                  const nextState = {
                    ...prev,
                    [cacheKey]:
                      result.status === 'success'
                        ? {
                            ...adapter.buildSuccessState(result.data),
                            mergedObservedAtMs: result.observedAtMs,
                          }
                        : adapter.buildErrorState(
                            result.error || t('common.unknown_error'),
                            result.errorStatus
                          ),
                  };
                  committedState = nextState[cacheKey];
                  return nextState;
                });
              });

              if (result.status === 'success' && committedState) {
                void enrichQuotaInBackground(adapter, file, result.data, committedState, t);
              }
            }
          })
        );
        return requestId === requestIdRef.current;
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [t]
  );

  return { batchLoading, loadQuota };
}
