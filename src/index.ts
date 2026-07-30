interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Hawaii vehicle-registration MCP — the statewide cumulative count of hybrid and electric
 * vehicles registered in Hawaii, as a clean annual series from 1999 to the present. Keyless.
 *
 * One pack per state agency, with a Hawaii-specific wrinkle: vehicle registration in Hawaii
 * is administered by the four counties (Honolulu, Hawaii, Maui, Kauai), not by a state DMV,
 * and the statewide statistics are compiled and published by DBEDT, the state Department of
 * Business, Economic Development and Tourism. So there is no state office to query and no
 * county breakdown in this series — what exists is one authoritative statewide row per year.
 *
 * Source (verified live 2026-07-29):
 *   opendata.hawaii.gov CKAN resource 4d4c0403-8f04-4f74-879d-64669f1437b1 —
 *   "Cumulative Hybrid & Electric Vehicles Registered", 26 annual rows, 1999 through 2024.
 *
 * Two shapes worth knowing: counts arrive as thousands-separated strings ("31,284"), and a
 * missing value arrives as the padded string " -   " rather than null or zero — 1999 has no
 * hybrid figure at all, and reading that as 0 would invent a data point.
 *
 * The tool resolves to a shaped object and never throws; an unavailable year comes back as
 * { found: false, reason, hint } naming the years that exist.
 */


const UA = 'pipeworx-mcp-hi-dmv/1.0 (+https://pipeworx.io)';
const CKAN_DOMAIN = 'opendata.hawaii.gov';
const EV_RESOURCE = '4d4c0403-8f04-4f74-879d-64669f1437b1';
const SOURCE =
  'opendata.hawaii.gov — Hawaii DBEDT Cumulative Hybrid & Electric Vehicles Registered ' +
  '(compiled from county motor-vehicle registration records)';

const tools: McpToolExport['tools'] = [
  {
    name: 'hi_dmv_ev_registrations',
    description:
      'Count electric and hybrid vehicles registered in Hawaii as an annual time series from 1999 to the present, with battery-electric and hybrid vehicles counted separately plus a combined total, and the year-over-year change and growth rate for each year. Answers "how many electric vehicles are in Hawaii", "how many EVs were registered in Hawaii in 2020", "EV adoption trend in Hawaii", "how fast is EV adoption growing in Hawaii", and "how many hybrid cars are in Hawaii". Figures are cumulative registered counts compiled statewide by Hawaii DBEDT; registration itself is administered by the four counties (Honolulu, Hawaii, Maui, Kauai), so this series is published at the state level.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'Four-digit calendar year, 1999 onward, e.g. "2024". Omit for the whole series, newest first.' },
        limit: { type: ['number', 'string'], description: 'Max years to return, newest first (default 30, max 60).' },
      },
    },
  },
];

interface HiRecord {
  Year?: unknown;
  'Hybrid Electric Vehicles'?: unknown;
  'Electric Vehicle'?: unknown;
  Total?: unknown;
}

interface HiYear {
  year: number;
  hybrid_vehicles: number | null;
  electric_vehicles: number | null;
  total_electrified_vehicles: number | null;
}

async function evRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const records = await ckanRows<HiRecord>(CKAN_DOMAIN, EV_RESOURCE, 200, { userAgent: UA });
  if (!records.length) {
    return govNotFound('upstream_empty', 'opendata.hawaii.gov returned no rows; retry once.');
  }

  // govNumber strips the thousands separators and resolves the padded " -   " placeholder to
  // null, which is what it means: no figure published, as opposed to a count of zero.
  const series: HiYear[] = records
    .map((r) => ({
      year: govNumber(r.Year) ?? 0,
      hybrid_vehicles: govNumber(r['Hybrid Electric Vehicles']),
      electric_vehicles: govNumber(r['Electric Vehicle']),
      total_electrified_vehicles: govNumber(r.Total),
    }))
    .filter((r) => r.year > 0)
    .sort((a, b) => a.year - b.year);

  const years = series.map((r) => r.year);
  const firstYear = years[0];
  const lastYear = years[years.length - 1];

  const requested = govString(args, 'year');
  if (requested && !series.some((r) => String(r.year) === requested)) {
    return govNotFound(
      'year_unavailable',
      `Hawaii publishes this series annually for ${firstYear}–${lastYear}. Retry with one of those years, or omit year for the whole trend.`,
      { requested_year: requested, available_years: `${firstYear}-${lastYear}` },
    );
  }

  // Growth is computed against the previous published year before any filtering, so a
  // single-year request still gets a real year-over-year change.
  const withGrowth = series.map((r, i) => {
    const prev = i > 0 ? series[i - 1].total_electrified_vehicles : null;
    const cur = r.total_electrified_vehicles;
    return {
      ...r,
      change_from_prior_year: prev !== null && cur !== null ? cur - prev : null,
      growth_pct: prev !== null && prev > 0 && cur !== null ? Math.round(((cur - prev) / prev) * 1000) / 10 : null,
    };
  });

  const limit = govLimit(args.limit, 30, 60);
  const filtered = requested ? withGrowth.filter((r) => String(r.year) === requested) : withGrowth;
  const rows = [...filtered].reverse().slice(0, limit);
  const latest = withGrowth[withGrowth.length - 1];

  return {
    state: 'HI',
    grain: requested
      ? `statewide cumulative hybrid and electric vehicles registered in ${requested}`
      : 'statewide cumulative hybrid and electric vehicles registered, one row per year, newest first',
    as_of: String(lastYear),
    source: SOURCE,
    covers_years: `${firstYear}-${lastYear}`,
    // Each row is already the statewide cumulative count for its year, so the latest year is
    // a genuine total. Rows from different years are cumulative snapshots of largely the same
    // vehicles and are deliberately not summed.
    ...(requested
      ? {
          electric_vehicles: rows[0]?.electric_vehicles ?? null,
          hybrid_vehicles: rows[0]?.hybrid_vehicles ?? null,
          total_electrified_vehicles: rows[0]?.total_electrified_vehicles ?? null,
        }
      : {
          latest_year: latest.year,
          latest_electric_vehicles: latest.electric_vehicles,
          latest_hybrid_vehicles: latest.hybrid_vehicles,
          latest_total_electrified_vehicles: latest.total_electrified_vehicles,
        }),
    returned_years: rows.length,
    truncated: filtered.length > rows.length,
    rows,
    note:
      'Counts are cumulative registered vehicles at the end of each year, so a rising total means the fleet grew, and the annual change is reported per row. Hawaii counts conventional hybrids separately from battery-electric vehicles; total_electrified_vehicles is the sum of both. A null figure means Hawaii published no value for that year (1999 has no hybrid count) rather than a count of zero.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'hi_dmv_ev_registrations': return await evRegistrations(args);
      default:
        return govNotFound('unknown_tool', `hi-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `hi-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'opendata.hawaii.gov timed out. Retry once — the CKAN datastore is slow under load.'
        : 'opendata.hawaii.gov refused the request or changed shape. Retry once; if it persists the resource may have been republished under a new CKAN resource id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
