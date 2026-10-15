// Yandex Metrika: management API (counters, goals) and reporting API (/stat/v1/data). OAuth token with the metrika:read
// scope: header `Authorization: OAuth <token>`. Quotas: 3 parallel requests, 200 reports per 5 minutes per user.
import { queryString, request, z } from '../core.mjs';

const METRIKA_URL = 'https://api-metrika.yandex.net';
const CENT = 100;
const COUNTERS_MAX = 200;
const COUNTERS_DEFAULT = 50;
const ROWS_MAX = 100;
const ROWS_DEFAULT = 20;
const GOALS_MAX = 5; // two metrics per goal on top of five basic ones; Metrika takes 20 metrics in a request
/** YYYY-MM-DD, today, yesterday or NdaysAgo — what date1/date2 accept. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/;
const ATTRIBUTIONS = ['last', 'cross_device_last_significant', 'cross_device_first', 'automatic'];

/** [output key, metric]: visits, visitors, page views, share of bounces (%), average visit length. */
const SUMMARY_METRICS = [
  ['visits', 'ym:s:visits'],
  ['users', 'ym:s:users'],
  ['pageviews', 'ym:s:pageviews'],
  ['bounceRate', 'ym:s:bounceRate'],
  ['avgVisitSeconds', 'ym:s:avgVisitDurationSeconds'],
];
const SOURCE_METRICS = [
  ['visits', 'ym:s:visits'],
  ['users', 'ym:s:users'],
  ['bounceRate', 'ym:s:bounceRate'],
  ['pageDepth', 'ym:s:pageDepth'],
  ['avgVisitSeconds', 'ym:s:avgVisitDurationSeconds'],
];
/** Breakdowns of the traffic; <attribution> is filled from the `attribution` parameter of the request. */
const GROUPS = {
  type: ['ym:s:<attribution>TrafficSource'],
  engine: ['ym:s:<attribution>SourceEngine'],
  referrer: ['ym:s:<attribution>ReferalSource'],
  utm: ['ym:s:<attribution>UTMSource', 'ym:s:<attribution>UTMMedium', 'ym:s:<attribution>UTMCampaign'],
};

const base = (env) => (env.METRIKA_API_URL || METRIKA_URL).replace(/\/+$/, '');
const get = (env, path, params) => request(`${base(env)}${path}${queryString(params)}`, { headers: { Authorization: `OAuth ${env.METRIKA_TOKEN}` } });
const round = (x) => (typeof x === 'number' ? Math.round(x * CENT) / CENT : x);
/** Metric values by output key. */
const zip = (keys, values = []) => Object.fromEntries(keys.map((key, i) => [key, round(values[i])]));
const periodOf = (d) => ({ from: d?.query?.date1, to: d?.query?.date2 });
/** A sampled answer is approximate: the share of the visits it was counted on. */
const samplingOf = (d) => (d?.sampled ? { sampled: true, sampleShare: d.sample_share } : {});
/** The next page starts after the rows seen, while the total says there are more (offsets count from 1). */
const nextOffsetOf = (offset, count, total) => (offset + count <= (total ?? 0) ? { nextOffset: offset + count } : {});

const counterOut = (c) => ({
  id: c.id,
  name: c.name,
  site: c.site2?.site ?? c.site,
  status: c.status,
  activity: c.activity_status,
  type: c.type,
  permission: c.permission,
  owner: c.owner_login,
  createdAt: c.create_time,
  goals: c.goals?.map((g) => ({ id: g.id, name: g.name, type: g.type })),
});

function sourceRow(row) {
  const dims = row.dimensions ?? [];
  return {
    source: dims.map((x) => x.name ?? x.id).join(' / '),
    id: dims.length === 1 ? dims[0].id : undefined,
    ...zip(SOURCE_METRICS.map(([key]) => key), row.metrics),
  };
}

const counterIdInput = z.number().int().min(1).describe('Counter id from metrika_counters');
const dateInput = (what) => z.string().regex(DATE, 'Expected YYYY-MM-DD, today, yesterday or NdaysAgo').optional().describe(what);
const offsetInput = z.number().int().min(1).optional().describe('Number of the first row, 1 by default');

export default {
  name: 'yandex-metrika',
  title: 'Yandex Metrika',
  env: ['METRIKA_TOKEN'],
  tools: [
    {
      name: 'metrika_counters',
      description: 'Yandex Metrika counters you have access to: id, name, site, status, access level. withGoals=true adds the goals of each counter '
        + '(id, name, type) — the ids for metrika_summary. When nextOffset is returned, call again with offset=nextOffset.',
      input: {
        search: z.string().min(1).optional().describe('Part of a name or site, or a whole counter id'),
        withGoals: z.boolean().optional(),
        limit: z.number().int().min(1).max(COUNTERS_MAX).optional().describe(`Counters, default ${COUNTERS_DEFAULT}`),
        offset: offsetInput,
      },
      maxItems: COUNTERS_MAX,
      run: async ({ search, withGoals, limit = COUNTERS_DEFAULT, offset = 1 }, env) => {
        const d = await get(env, '/management/v1/counters', { per_page: limit, offset, search_string: search, field: withGoals ? 'goals' : undefined });
        const counters = (d?.counters ?? []).map(counterOut);
        return { counters, ...nextOffsetOf(offset, counters.length, d?.rows) };
      },
    },
    {
      name: 'metrika_summary',
      description: 'Yandex Metrika totals of one counter for a period: visits, visitors, page views, bounce rate (%), average visit seconds. '
        + 'With goalIds (up to 5, see metrika_counters withGoals) adds the reaches and the conversion rate (% of visits) of each goal. '
        + 'The answer is marked sampled when Metrika counted on a part of the visits.',
      input: {
        counterId: counterIdInput,
        dateFrom: dateInput('Start: YYYY-MM-DD, today, yesterday or NdaysAgo; default 6daysAgo'),
        dateTo: dateInput('End: same formats; default today'),
        goalIds: z.array(z.number().int().min(1)).min(1).max(GOALS_MAX).optional().describe('Goal ids'),
      },
      run: async ({ counterId, dateFrom, dateTo, goalIds = [] }, env) => {
        const goalMetrics = goalIds.flatMap((id) => [`ym:s:goal${id}reaches`, `ym:s:goal${id}conversionRate`]);
        const metrics = [...SUMMARY_METRICS.map(([, metric]) => metric), ...goalMetrics];
        const d = await get(env, '/stat/v1/data', { ids: counterId, metrics: metrics.join(','), date1: dateFrom, date2: dateTo, lang: 'ru' });
        const values = d?.totals ?? d?.data?.[0]?.metrics ?? [];
        const first = SUMMARY_METRICS.length;
        const goals = goalIds.map((id, i) => ({ id, reaches: values[first + 2 * i], conversionRate: round(values[first + 2 * i + 1]) }));
        return { period: periodOf(d), ...zip(SUMMARY_METRICS.map(([key]) => key), values), goals, ...samplingOf(d) };
      },
    },
    {
      name: 'metrika_sources',
      description: 'Yandex Metrika traffic sources of one counter for a period, biggest first: visits, visitors, bounce rate (%), pages per visit, '
        + 'average visit seconds. groupBy: type (search, direct, referral, ad, social … — the default), engine (detailed source), referrer (sites), utm '
        + '(source / medium / campaign). When nextOffset is returned, call again with offset=nextOffset.',
      input: {
        counterId: counterIdInput,
        dateFrom: dateInput('Start: YYYY-MM-DD, today, yesterday or NdaysAgo; default 6daysAgo'),
        dateTo: dateInput('End: same formats; default today'),
        groupBy: z.enum(Object.keys(GROUPS)).optional(),
        attribution: z.enum(ATTRIBUTIONS).optional().describe('Attribution model, default last'),
        limit: z.number().int().min(1).max(ROWS_MAX).optional().describe(`Rows, default ${ROWS_DEFAULT}`),
        offset: offsetInput,
      },
      maxItems: ROWS_MAX,
      run: async ({ counterId, dateFrom, dateTo, groupBy = 'type', attribution = 'last', limit = ROWS_DEFAULT, offset = 1 }, env) => {
        const params = {
          ids: counterId, metrics: SOURCE_METRICS.map(([, metric]) => metric).join(','), dimensions: GROUPS[groupBy].join(','), attribution,
          sort: '-ym:s:visits', date1: dateFrom, date2: dateTo, limit, offset, lang: 'ru',
        };
        const d = await get(env, '/stat/v1/data', params);
        const rows = (d?.data ?? []).map(sourceRow);
        return {
          period: periodOf(d), rows, totals: zip(SOURCE_METRICS.map(([key]) => key), d?.totals), ...samplingOf(d), ...nextOffsetOf(offset, rows.length, d?.total_rows),
        };
      },
    },
  ],
};
