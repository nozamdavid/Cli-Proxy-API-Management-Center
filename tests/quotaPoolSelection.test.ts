import { describe, expect, test } from 'bun:test';
import { opaqueQuotaSignature } from '@/features/quota/mergedQuota';
import { createQuotaGraphCacheScope } from '@/features/quota/graphCache';
import {
  createQuotaPoolSelectionStore,
  getQuotaPoolSelectionId,
  resolveQuotaPoolSelection,
  type QuotaPoolSelectionStorage,
} from '@/features/quota/poolSelection';

const weeklyGeminiId = getQuotaPoolSelectionId(
  `antigravity:${JSON.stringify(['Gemini Models', 'gemini-weekly', 'weekly'])}`
);

const pool = (selectionId: string) => ({ selectionId });

const memoryStorage = (): QuotaPoolSelectionStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

describe('quota pool selection', () => {
  test('defaults Antigravity to Gemini weekly regardless of sort order', () => {
    const first = pool(getQuotaPoolSelectionId('antigravity:five-hour'));
    const weekly = pool(weeklyGeminiId);
    expect(resolveQuotaPoolSelection([first, weekly], 'antigravity')).toBe(weekly);
    expect(resolveQuotaPoolSelection([first, weekly], 'codex')).toBe(first);
  });

  test('restores an explicit pool and keeps its opaque identity across cached and live views', () => {
    const semanticPoolKey = `antigravity:${JSON.stringify([
      'Gemini Models',
      'gemini-weekly',
      'weekly',
    ])}`;
    const liveSelectionId = getQuotaPoolSelectionId(semanticPoolKey);
    const cachedSelectionId = opaqueQuotaSignature(semanticPoolKey);
    const savedPool = pool(getQuotaPoolSelectionId('antigravity:five-hour'));

    expect(liveSelectionId).toBe(cachedSelectionId);
    expect(
      resolveQuotaPoolSelection(
        [pool(liveSelectionId), savedPool],
        'antigravity',
        savedPool.selectionId
      )
    ).toBe(savedPool);
    expect(
      resolveQuotaPoolSelection([pool(cachedSelectionId)], 'antigravity', liveSelectionId)
        ?.selectionId
    ).toBe(liveSelectionId);
  });

  test('falls back when a saved pool is unavailable without replacing the preference', () => {
    const scope = createQuotaGraphCacheScope('https://quota.example', 'management-one');
    const storage = memoryStorage();
    const selections = createQuotaPoolSelectionStore(storage);
    const savedId = getQuotaPoolSelectionId('antigravity:removed-pool');
    selections.write(scope, 'antigravity', savedId);

    expect(
      resolveQuotaPoolSelection([pool(weeklyGeminiId)], 'antigravity', savedId)?.selectionId
    ).toBe(weeklyGeminiId);
    expect(selections.read(scope).antigravity).toBe(savedId);
    expect(resolveQuotaPoolSelection([], 'antigravity', savedId)).toBeNull();
    const codexPoolId = getQuotaPoolSelectionId('codex:pool');
    expect(
      resolveQuotaPoolSelection([pool(codexPoolId)], 'codex', savedId)?.selectionId
    ).toBe(codexPoolId);
  });

  test('scopes provider choices independently and falls back to memory for corrupt or unavailable storage', () => {
    const storage = memoryStorage();
    const selections = createQuotaPoolSelectionStore(storage);
    const firstScope = createQuotaGraphCacheScope(
      'https://quota.example',
      'management-one'
    );
    const secondScope = createQuotaGraphCacheScope(
      'https://quota.example',
      'management-two'
    );
    const antigravityId = getQuotaPoolSelectionId('antigravity:five-hour');
    const codexId = getQuotaPoolSelectionId('codex:weekly');

    selections.write(firstScope, 'antigravity', antigravityId);
    selections.write(firstScope, 'codex', codexId);
    selections.write(secondScope, 'antigravity', weeklyGeminiId);
    expect(selections.read(firstScope)).toEqual({ antigravity: antigravityId, codex: codexId });
    expect(selections.read(secondScope)).toEqual({ antigravity: weeklyGeminiId });
    expect(createQuotaPoolSelectionStore(storage).read(firstScope)).toEqual({
      antigravity: antigravityId,
      codex: codexId,
    });
    expect(JSON.stringify(Array.from(storage.values.entries()))).not.toContain('management-one');
    expect(JSON.stringify(Array.from(storage.values.entries()))).not.toContain('management-two');

    const corruptStore = createQuotaPoolSelectionStore({
      getItem: () => '{invalid json',
      setItem: () => undefined,
    });
    expect(corruptStore.read(firstScope)).toEqual({});
    expect(
      resolveQuotaPoolSelection(
        [pool(weeklyGeminiId)],
        'antigravity',
        corruptStore.read(firstScope).antigravity
      )?.selectionId
    ).toBe(weeklyGeminiId);

    const unavailableStore = createQuotaPoolSelectionStore({
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    });
    unavailableStore.write(firstScope, 'antigravity', antigravityId);
    expect(unavailableStore.read(firstScope).antigravity).toBe(antigravityId);
  });
});
