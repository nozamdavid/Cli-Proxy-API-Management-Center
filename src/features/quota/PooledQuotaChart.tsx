import { useId, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_GRAPH_PICKER_COLOR } from './graphColorPreferences';
import type { QuotaGraphSnapshotProjection } from './graphCache';
import {
  projectPooledQuota,
  type PooledQuotaProjection,
  type PooledQuotaSummary,
  type QuotaPoolHistory,
} from './mergedQuota';
import type { QuotaProviderType } from './providers/types';
import styles from './MergedQuotaSummary.module.scss';

export interface PooledQuotaPoolView extends PooledQuotaSummary {
  cachedProjection?: QuotaGraphSnapshotProjection;
  key: string;
  selectionId: string;
  label: string;
  provider: QuotaProviderType;
  periodHours: number | null;
  selectLabel: string;
  eligibleCount: number;
  exposedCount: number;
  disabledCount: number;
  membershipSignature: string;
  historyStorageKey: string;
}

interface PooledQuotaChartProps {
  providerName: string;
  pools: PooledQuotaPoolView[];
  pool: PooledQuotaPoolView;
  history: QuotaPoolHistory;
  selectedPoolKey: string;
  onSelectPool: (key: string) => void;
  nowMs: number;
  fresh: boolean;
  cached: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  updatedAtMs: number | null;
  language: string;
  graphColor: string | null;
  onChangeGraphColor: (value: string) => void;
  onResetGraphColor: () => void;
}

const CHART_WIDTH = 960;
const CHART_HEIGHT = 300;
const PLOT = { left: 76, right: 24, top: 18, bottom: 48 };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DATA_TABLE_POINT_LIMIT = 100;

const numberLabel = (value: number, language: string): string =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);

const formatRelative = (targetMs: number | null, nowMs: number, language: string): string => {
  if (targetMs === null) return '';
  const deltaMs = targetMs - nowMs;
  const absMs = Math.abs(deltaMs);
  const unit: Intl.RelativeTimeFormatUnit =
    absMs < HOUR_MS
      ? 'minute'
      : absMs < DAY_MS
        ? 'hour'
        : absMs < 7 * DAY_MS
          ? 'day'
          : 'week';
  const divisor =
    unit === 'minute' ? 60_000 : unit === 'hour' ? HOUR_MS : unit === 'day' ? DAY_MS : 7 * DAY_MS;
  const value = Math.round(deltaMs / divisor);
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(value, unit);
};

const makePath = (
  points: { atMs: number; remainingPercent: number }[],
  x: (atMs: number) => number,
  y: (remainingPercent: number) => number
): string =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'} ${x(point.atMs)} ${y(point.remainingPercent)}`
    )
    .join(' ');

export function PooledQuotaChart({
  providerName,
  pools,
  pool,
  history,
  selectedPoolKey,
  onSelectPool,
  nowMs,
  fresh,
  cached,
  refreshing,
  refreshFailed,
  updatedAtMs,
  language,
  graphColor,
  onChangeGraphColor,
  onResetGraphColor,
}: PooledQuotaChartProps) {
  const { t } = useTranslation();
  const chartInstanceId = useId();
  const headingId = `${chartInstanceId}-heading`;
  const svgId = `${chartInstanceId}-svg`;
  const svgTitleId = `${chartInstanceId}-svg-title`;
  const computedProjection: PooledQuotaProjection | null = useMemo(
    () =>
      cached
        ? null
        : projectPooledQuota(pool.contributors, history, pool.membershipSignature, nowMs),
    [cached, history, nowMs, pool.contributors, pool.membershipSignature]
  );
  const cachedProjection = cached ? pool.cachedProjection ?? null : null;
  const projection = cached ? cachedProjection : computedProjection;

  const width = CHART_WIDTH - PLOT.left - PLOT.right;
  const height = CHART_HEIGHT - PLOT.top - PLOT.bottom;
  const firstRecorded = history.points[0]?.atMs;
  const firstProjected = projection?.points[0]?.atMs;
  const spanStartMs = Math.max(
    nowMs - DAY_MS * 14,
    Math.min(firstRecorded ?? nowMs - HOUR_MS, firstProjected ?? nowMs - HOUR_MS, nowMs - HOUR_MS)
  );
  const projectionVisible = cached ? projection !== null : fresh;
  const forecastEndMs = projectionVisible ? projection?.points[projection.points.length - 1]?.atMs : null;
  const spanEndMs = Math.max(nowMs + HOUR_MS, forecastEndMs ?? nowMs + HOUR_MS);
  const timeSpanMs = Math.max(1, spanEndMs - spanStartMs);
  const capacity = pool.capacityPercent;
  const yMax = capacity > 0 ? capacity : 100;
  const x = (atMs: number) => PLOT.left + ((atMs - spanStartMs) / timeSpanMs) * width;
  const y = (remainingPercent: number) =>
    PLOT.top + height - (Math.max(0, Math.min(yMax, remainingPercent)) / yMax) * height;
  const recordedPath = makePath(history.points, x, y);
  const projectionPoints = projectionVisible && projection ? projection.points : [];
  const projectionPath = makePath(projectionPoints, x, y);
  const recordedTablePoints = history.points.slice(-DATA_TABLE_POINT_LIMIT);
  const projectedTablePoints = projectionPoints.slice(0, DATA_TABLE_POINT_LIMIT);
  const omittedRecordedPoints = history.points.length - recordedTablePoints.length;
  const omittedProjectedPoints = projectionPoints.length - projectedTablePoints.length;
  const hasOmittedTablePoints = omittedRecordedPoints > 0 || omittedProjectedPoints > 0;
  const areaPath =
    history.points.length > 1
      ? `${recordedPath} L ${x(history.points[history.points.length - 1].atMs)} ${y(0)} L ${x(
          history.points[0].atMs
        )} ${y(0)} Z`
      : '';
  const dateOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };
  if (spanEndMs - spanStartMs >= DAY_MS) {
    dateOptions.month = 'short';
    dateOptions.day = 'numeric';
  }
  const dateFormatter = new Intl.DateTimeFormat(language, dateOptions);
  const fullDateTimeFormatter = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const yTicks = Array.from({ length: 5 }, (_, index) => (yMax * index) / 4);
  const xTicks = Array.from({ length: 5 }, (_, index) =>
    spanStartMs + (timeSpanMs * index) / 4
  );
  const resets = projectionPoints.filter((point) => point.reset);
  const remainingLabel = numberLabel(pool.remainingPercent, language);
  const remainingMarker = '__merged_quota_remaining__';
  const headlineTemplate =
    capacity > 0
      ? t('quota_management.merged_pool_headline', {
          remaining: remainingMarker,
          capacity: numberLabel(capacity, language),
          defaultValue: `${remainingMarker}% of ${numberLabel(capacity, language)}%`,
        })
      : t('quota_management.merged_unavailable', { defaultValue: 'Unavailable' });
  const remainingMarkerIndex = capacity > 0 ? headlineTemplate.indexOf(remainingMarker) : -1;
  const headlinePrefix =
    remainingMarkerIndex >= 0 ? headlineTemplate.slice(0, remainingMarkerIndex) : '';
  const headlineRemainder =
    remainingMarkerIndex >= 0
      ? headlineTemplate.slice(remainingMarkerIndex + remainingMarker.length)
      : '';
  const remainingUnit = headlineRemainder.startsWith('%') ? '%' : '';
  const headlineSuffix =
    remainingMarkerIndex >= 0
      ? headlineRemainder.slice(remainingUnit.length).trimStart()
      : '';
  const headline =
    remainingMarkerIndex >= 0
      ? `${headlinePrefix}${remainingLabel}${headlineTemplate.slice(
          remainingMarkerIndex + remainingMarker.length
        )}`
      : capacity > 0
        ? t('quota_management.merged_pool_headline', {
            remaining: numberLabel(pool.remainingPercent, language),
            capacity: numberLabel(capacity, language),
            defaultValue: `${remainingLabel}% of ${numberLabel(capacity, language)}%`,
          })
        : headlineTemplate;
  const coverage = t('quota_management.merged_pool_coverage', {
    known: pool.contributors.length,
    total: pool.eligibleCount,
    excluded: Math.max(0, pool.eligibleCount - pool.contributors.length),
    exposed: pool.exposedCount,
    disabled: pool.disabledCount,
    defaultValue:
      `${pool.contributors.length} of ${pool.eligibleCount} enabled accounts contribute; ` +
      `${Math.max(0, pool.eligibleCount - pool.contributors.length)} unavailable or unknown; ` +
      `${pool.exposedCount} expose this window; ${pool.disabledCount} disabled`,
  });
  const accountCount = t('quota_management.merged_pool_accounts', {
    count: pool.contributors.length,
    capacity: numberLabel(capacity, language),
    defaultValue:
      `${pool.contributors.length} accounts · ${numberLabel(capacity, language)}% capacity`,
  });
  const forecastLabel = cachedProjection
    ? t('quota_management.merged_projection_cached', {
        time: fullDateTimeFormatter.format(cachedProjection.generatedAtMs),
        defaultValue: `Cached estimate · Generated ${fullDateTimeFormatter.format(
          cachedProjection.generatedAtMs
        )}`,
      })
    : !fresh
      ? t('quota_management.merged_collecting_history', {
          defaultValue: 'Collecting history; no usage estimate yet.',
        })
      : projection?.burnRatePercentPerHour !== null && projection !== null
        ? t('quota_management.merged_projection_burn', {
            defaultValue: 'Estimate from recent burn and known resets',
          })
        : projection?.nextResetAtMs !== null && projection !== null
          ? t('quota_management.merged_projection_reset_only', {
              defaultValue: 'Reset-only estimate; assumes no further use',
            })
          : t('quota_management.merged_collecting_history', {
              defaultValue: 'Collecting history; no usage estimate yet.',
            });
  const historyMessage =
    history.points.length === 0
      ? t('quota_management.merged_history_starts', {
          defaultValue: 'History starts with first refresh.',
        })
      : '';
  const burnValue =
    projection?.burnRatePercentPerHour == null
      ? t('quota_management.merged_no_estimate', { defaultValue: 'No estimate' })
      : `${numberLabel(projection.burnRatePercentPerHour, language)}%/h`;
  const nextResetValue = formatRelative(projection?.nextResetAtMs ?? null, nowMs, language);
  const poolEmptyValue = formatRelative(projection?.poolEmptyAtMs ?? null, nowMs, language);
  const tickLabel = (atMs: number): string => dateFormatter.format(atMs);
  const nowX = x(nowMs);
  const updatedLabel =
    updatedAtMs === null ? '' : fullDateTimeFormatter.format(updatedAtMs);
  const graphStatus = [
    cached
      ? t('quota_management.merged_graph_cached', {
          time: updatedLabel,
          defaultValue: `Cached · Last updated ${updatedLabel}`,
        })
      : updatedLabel
        ? t('quota_management.merged_graph_updated', {
            time: updatedLabel,
            defaultValue: `Last updated ${updatedLabel}`,
          })
        : '',
    refreshing ? t('quota_management.merged_refreshing', { defaultValue: 'Refreshing' }) : '',
    refreshFailed && cached
      ? t('quota_management.merged_graph_stale', {
          defaultValue: 'Refresh failed; showing cached data.',
        })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      className={styles.pooledChart}
      aria-labelledby={headingId}
      style={graphColor ? ({ '--graph-color': graphColor } as CSSProperties) : undefined}
    >
      <div className={styles.pooledChartHeader}>
        <div className={styles.pooledHeadlineBlock}>
          <h3 id={headingId} className={styles.sectionTitle}>
            {providerName} ·{' '}
            {t('quota_management.merged_pooled_title', { defaultValue: 'Pooled remaining' })}
          </h3>
          <p className={styles.pooledHeadline}>
            <span className={styles.visuallyHidden}>{headline}</span>
            {remainingMarkerIndex >= 0 ? (
              <span aria-hidden="true">
                {headlinePrefix}
                <span className={styles.pooledHeadlineRemaining}>
                  {remainingLabel}
                  {remainingUnit}
                </span>
                <span className={styles.pooledHeadlineCapacity}>{headlineSuffix}</span>
              </span>
            ) : (
              <span aria-hidden="true">{headline}</span>
            )}
          </p>
          <p className={styles.summaryMeta}>{accountCount}</p>
        </div>
        <div className={styles.chartControls}>
          <label className={styles.poolSelectLabel}>
            <span>{t('quota_management.merged_pool_select', { defaultValue: 'Quota pool' })}</span>
            <select
              className={styles.poolSelect}
              value={selectedPoolKey}
              onChange={(event) => onSelectPool(event.target.value)}
            >
              {pools.map((option) => (
                <option key={option.selectionId} value={option.selectionId}>
                  {option.selectLabel}
                </option>
              ))}
            </select>
            <span className={styles.selectedPoolName} aria-live="polite">
              {pool.selectLabel}
            </span>
          </label>
          <div className={styles.graphColorActions}>
            <label className={styles.graphColorLabel}>
              <span>{t('quota_management.merged_graph_color', { defaultValue: 'Graph color' })}</span>
              <input
                className={styles.graphColorInput}
                type="color"
                value={graphColor ?? DEFAULT_GRAPH_PICKER_COLOR}
                aria-label={t('quota_management.merged_graph_color_aria', {
                  provider: providerName,
                  defaultValue: `${providerName} graph color`,
                })}
                onChange={(event) => onChangeGraphColor(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className={styles.graphColorReset}
              aria-label={t('quota_management.merged_graph_color_reset_aria', {
                provider: providerName,
                defaultValue: `Reset ${providerName} graph color`,
              })}
              onClick={onResetGraphColor}
              disabled={!graphColor}
            >
              {t('quota_management.merged_graph_color_reset', { defaultValue: 'Reset' })}
            </button>
          </div>
        </div>
      </div>

      <p className={styles.coverage}>{coverage}</p>
      {graphStatus && (
        <p className={styles.graphStatus} role="status">
          {graphStatus}
        </p>
      )}

      <div className={styles.chartFrame}>
        <svg
          id={svgId}
          className={styles.chartSvg}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="group"
          aria-labelledby={svgTitleId}
        >
          <title id={svgTitleId}>
            {t('quota_management.merged_chart_aria', {
              pool: `${providerName} · ${pool.label}`,
              defaultValue: `${providerName} · ${pool.label} pooled remaining over time`,
            })}
          </title>
          {yTicks.map((value) => (
            <g key={`y-${value}`}>
              <line
                className={styles.chartGrid}
                x1={PLOT.left}
                x2={CHART_WIDTH - PLOT.right}
                y1={y(value)}
                y2={y(value)}
              />
              <text className={styles.chartAxisLabel} x={PLOT.left - 12} y={y(value) + 4}>
                {numberLabel(value, language)}%
              </text>
            </g>
          ))}
          {xTicks.map((value) => (
            <g key={`x-${value}`}>
              <line
                className={styles.chartGridVertical}
                x1={x(value)}
                x2={x(value)}
                y1={PLOT.top}
                y2={PLOT.top + height}
              />
              <text
                className={styles.chartAxisLabel}
                x={x(value)}
                y={CHART_HEIGHT - 14}
                textAnchor="middle"
              >
                {tickLabel(value)}
              </text>
            </g>
          ))}
          <line
            className={styles.nowLine}
            x1={nowX}
            x2={nowX}
            y1={PLOT.top}
            y2={PLOT.top + height}
          />
          <text className={styles.nowLabel} x={nowX + 5} y={PLOT.top + 12}>
            {t('quota_management.merged_now', { defaultValue: 'Now' })}
          </text>
          {areaPath && <path className={styles.recordedArea} d={areaPath} />}
          {recordedPath && <path className={styles.recordedLine} d={recordedPath} />}
          {history.points.length === 1 && (
            <circle
              className={styles.recordedPoint}
              cx={x(history.points[0].atMs)}
              cy={y(history.points[0].remainingPercent)}
              r="4"
            >
              <title>
                {`${tickLabel(history.points[0].atMs)} · ${numberLabel(
                  history.points[0].remainingPercent,
                  language
                )}%`}
              </title>
            </circle>
          )}
          {projectionPath && projectionPoints.length > 1 && (
            <path className={styles.projectedLine} d={projectionPath} />
          )}
          {resets.map((point, index) => (
            <g
              key={`reset-${point.atMs}-${index}`}
              className={styles.resetMarker}
              tabIndex={0}
              role="img"
              aria-label={t('quota_management.merged_reset_tooltip', {
                time: tickLabel(point.atMs),
                value: numberLabel(point.remainingPercent, language),
                defaultValue:
                  `Known account reset at ${tickLabel(point.atMs)}; pool ` +
                  `${numberLabel(point.remainingPercent, language)}%`,
              })}
            >
              <title>
                {t('quota_management.merged_reset_tooltip', {
                  time: tickLabel(point.atMs),
                  value: numberLabel(point.remainingPercent, language),
                  defaultValue:
                    `Known account reset at ${tickLabel(point.atMs)}; pool ` +
                    `${numberLabel(point.remainingPercent, language)}%`,
                })}
              </title>
              <circle cx={x(point.atMs)} cy={y(point.remainingPercent)} r="5" />
            </g>
          ))}
        </svg>
      </div>

      <div
        className={styles.chartLegend}
        aria-label={t('quota_management.merged_legend', { defaultValue: 'Chart legend' })}
      >
        <span>
          <i className={styles.legendRecorded} />
          {t('quota_management.merged_recorded', { defaultValue: 'Recorded' })}
        </span>
        <span>
          <i className={styles.legendProjected} />
          {t('quota_management.merged_projected', { defaultValue: 'Projected' })}
        </span>
        <span>
          <i className={styles.legendReset} />
          {t('quota_management.merged_reset_legend', { defaultValue: 'Known reset' })}
        </span>
      </div>

      <div className={styles.chartStats}>
        <div>
          <span>{t('quota_management.merged_burn', { defaultValue: 'Burn' })}</span>
          <strong>{burnValue}</strong>
        </div>
        <div>
          <span>{t('quota_management.merged_next_reset', { defaultValue: 'Next reset' })}</span>
          <strong>
            {nextResetValue ||
              t('quota_management.merged_no_estimate', { defaultValue: 'No estimate' })}
          </strong>
        </div>
        <div>
          <span>{t('quota_management.merged_pool_empty', { defaultValue: 'Pool empty' })}</span>
          <strong>
            {poolEmptyValue ||
              t('quota_management.merged_no_estimate', { defaultValue: 'No estimate' })}
          </strong>
        </div>
      </div>

      <p className={styles.forecastNote}>{forecastLabel}</p>
      {historyMessage && <p className={styles.historyNote}>{historyMessage}</p>}
      <details className={styles.chartDataDetails}>
        <summary>
          {t('quota_management.merged_data_table', {
            pool: pool.label,
            defaultValue: `Chart data for ${pool.label}`,
          })}
        </summary>
        {hasOmittedTablePoints && (
          <p className={styles.chartDataNote}>
            {t('quota_management.merged_data_omitted', {
              recorded: omittedRecordedPoints,
              projected: omittedProjectedPoints,
              defaultValue:
                `${omittedRecordedPoints} recorded and ${omittedProjectedPoints} ` +
                'projected points omitted.',
            })}
          </p>
        )}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">
                  {t('quota_management.merged_data_series', { defaultValue: 'Series' })}
                </th>
                <th scope="col">
                  {t('quota_management.merged_data_time', { defaultValue: 'Time' })}
                </th>
                <th scope="col">
                  {t('quota_management.merged_data_remaining', { defaultValue: 'Remaining' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {recordedTablePoints.map((point) => (
                <tr key={`recorded-${point.atMs}`}>
                  <th scope="row">
                    {t('quota_management.merged_recorded', { defaultValue: 'Recorded' })}
                  </th>
                  <td>
                    <time dateTime={new Date(point.atMs).toISOString()}>
                      {fullDateTimeFormatter.format(point.atMs)}
                    </time>
                  </td>
                  <td>{numberLabel(point.remainingPercent, language)}%</td>
                </tr>
              ))}
              {projectedTablePoints.map((point, index) => (
                <tr key={`projected-${point.atMs}-${index}`}>
                  <th scope="row">
                    {point.reset
                      ? `${t('quota_management.merged_projected', {
                          defaultValue: 'Projected',
                        })} · ${t('quota_management.merged_reset_legend', {
                          defaultValue: 'Known reset',
                        })}`
                      : t('quota_management.merged_projected', { defaultValue: 'Projected' })}
                  </th>
                  <td>
                    <time dateTime={new Date(point.atMs).toISOString()}>
                      {fullDateTimeFormatter.format(point.atMs)}
                    </time>
                  </td>
                  <td>{numberLabel(point.remainingPercent, language)}%</td>
                </tr>
              ))}
              {recordedTablePoints.length === 0 && projectedTablePoints.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    {t('quota_management.merged_data_empty', {
                      defaultValue: 'No recorded or projected points for this pool.',
                    })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
