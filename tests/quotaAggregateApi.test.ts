import { describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { fetchQuotaAggregate, normalizeQuotaAggregate } from '@/services/api/quotaAggregate';

describe('aggregate quota API', () => {
  test('accepts empty provider arrays', () => {
    expect(
      normalizeQuotaAggregate({
        generated: '2026-10-26T09:00:00Z',
        antigravity: [],
        codex: [],
      })
    ).toEqual({
      generated: '2026-10-26T09:00:00Z',
      antigravity: [],
      codex: [],
    });
  });

  test(
    'filters to X-Codex quota signals and requests the authenticated route with refresh bypass',
    async () => {
      const response = {
        generated: '2026-10-26T09:00:00Z',
        antigravity: [],
        codex: [
          {
            name: 'codex.json',
            disabled: false,
            plan: null,
            quota: {
              signals: {
                'X-Codex-Active-Limit': 'codex',
                'X-Codex-Credits-Balance': '120',
                'X-Codex-Reset-After-Seconds': '60',
                'X-Codex-Reset-After': '60',
                'X-Codex-Primary-Used-Percent': '21',
                'X-Codex-Secondary-Reset-After-Seconds': '120',
                'X-Codex-Bengalfox-Primary-Used-Percent': '33',
                'X-Codex-Turn-State': 'ignored',
                Authorization: 'filtered',
              },
            },
            model_quotas: {
              'gpt-5': {
                signals: {
                  'X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Used-Percent': '20',
                  'X-Codex-Model-Limit': 'ignored',
                  Cookie: 'filtered',
                },
              },
            },
          },
        ],
      };
      const get = spyOn(apiClient, 'get').mockResolvedValue(response as never);

      try {
        const result = await fetchQuotaAggregate(true);

        expect(get).toHaveBeenCalledWith('/quota/aggregate?refresh=true');
        expect(result.codex[0]).toEqual({
          name: 'codex.json',
          disabled: false,
          plan: null,
          signals: {
            'X-Codex-Active-Limit': 'codex',
            'X-Codex-Credits-Balance': '120',
            'X-Codex-Reset-After-Seconds': '60',
            'X-Codex-Reset-After': '60',
            'X-Codex-Primary-Used-Percent': '21',
            'X-Codex-Secondary-Reset-After-Seconds': '120',
            'X-Codex-Bengalfox-Primary-Used-Percent': '33',
          },
          modelQuotas: {
            'gpt-5': {
              signals: {
                'X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Used-Percent': '20',
              },
            },
          },
        });
      } finally {
        get.mockRestore();
      }
    }
  );
});
