export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
  min_live_per_category: number;
  tilt_floor: number;
  tilt_cap: number;
  category_multiple_floor: number;
  category_multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_chains: 5,
  min_live_per_category: 3,
  tilt_floor: 0.5,
  tilt_cap: 2.0,
  category_multiple_floor: 0.05,
  category_multiple_cap: 1.5,
};

export const MODEL_VERSION = 'radar-2';
export const LIVE_ROWS = 24;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow extends SnapshotProtocol {
  rank: number;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    category_tilt: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  category_tilt: number;
  base_multiple: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface CalibrationRow {
  category: string;
  live_count: number;
  median_multiple: number;
  tilt: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  calibration: CalibrationRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const UNCLASSIFIED = 'Unknown';

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dateMilliseconds(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : null;
}

export function ageDays(
  asOf: string | null | undefined,
  listedAt: string | null | undefined,
): number | null {
  const end = dateMilliseconds(asOf);
  const start = dateMilliseconds(listedAt);
  if (end === null || start === null) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(p.name) &&
    !/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/.test(p.name) &&
    !/\b(wrapped|staked|staking)\b/i.test(p.name)
  );
}

export function liveProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) =>
      !isPreToken(p) &&
      p.category !== 'CEX' &&
      p.mcap_usd !== null &&
      p.mcap_usd > 0 &&
      p.tvl_usd > 0,
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : ordered[middle - 1]! / 2 + ordered[middle]! / 2;
}

function categoryKey(p: SnapshotProtocol): string {
  return p.category ?? UNCLASSIFIED;
}

function calibrationFor(
  snapshot: Snapshot,
  model: ModelConstants,
): { globalMultiple: number; calibration: CalibrationRow[] } {
  const ratios: number[] = [];
  const groups = new Map<string, number[]>();

  for (const p of liveProtocols(snapshot)) {
    const ratio = p.mcap_usd! / p.tvl_usd;
    ratios.push(ratio);
    const key = categoryKey(p);
    const group = groups.get(key);
    if (group) group.push(ratio);
    else groups.set(key, [ratio]);
  }

  // A snapshot without live comparables uses a neutral TVL multiple.
  const globalMultiple = median(ratios);
  const calibration = [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([category, values]): CalibrationRow => {
      const rawMedian = median(values);
      return {
        category,
        live_count: values.length,
        median_multiple: clamp(
          rawMedian,
          model.category_multiple_floor,
          model.category_multiple_cap,
        ),
        tilt:
          values.length >= model.min_live_per_category
            ? clamp(
                rawMedian / globalMultiple,
                model.tilt_floor,
                model.tilt_cap,
              )
            : 1,
      };
    });

  return { globalMultiple, calibration };
}

export function calibrate(
  snapshot: Snapshot,
): { globalMultiple: number; calibration: CalibrationRow[] } {
  return calibrationFor(snapshot, MODEL);
}

export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  globalMultiple: number,
  tilt: number,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const growthPct = clamp(
    p.change_7d ?? 0,
    model.growth_floor,
    model.growth_cap,
  );
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    model.maturity_range *
      Math.sqrt(Math.min(ageForModel, model.maturity_days) / model.maturity_days);
  const breadthMult =
    1 +
    model.breadth_per_chain *
      Math.min(p.chains.length, model.breadth_max_chains);
  const implied = Math.max(
    1,
    Math.round(
      p.tvl_usd *
        globalMultiple *
        tilt *
        growthMult *
        maturityMult *
        breadthMult,
    ),
  );
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1e9) return 250;
  if (p.tvl_usd >= 1e8) return 150;
  if (p.tvl_usd >= 1e7) return 100;
  return 50;
}

export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

export function gasFor(chain: string): string {
  switch (chain) {
    case 'Ethereum':
      return '$3–8';
    case 'Arbitrum':
    case 'Optimism':
    case 'Base':
    case 'Polygon':
    case 'Avalanche':
      return '$0.10–0.50';
    case 'Solana':
      return '~$0.01';
    case 'Binance':
      return '$0.10–0.30';
    case 'Tron':
    default:
      return '$1–3';
  }
}

export function actionFor(
  p: SnapshotProtocol,
  capital: number,
  chain: string,
): string {
  const category = (p.category ?? '').toLowerCase();
  const amount = `$${capital}`;
  const matches = (...parts: string[]): boolean =>
    parts.some((part) => category.includes(part));

  if (matches('lend', 'cdp', 'collateral')) {
    return `Supply ${amount} of USDC to ${p.name} on ${chain} and keep the position open.`;
  }
  if (matches('dex', 'yield', 'leveraged farm')) {
    return `Provide ${amount} of liquidity to ${p.name}'s main pool on ${chain} and keep the position open.`;
  }
  if (matches('bridge')) {
    return `Bridge ${amount} of USDC to ${chain} through ${p.name} and use the bridged funds in its app.`;
  }
  if (matches('staking', 'restak')) {
    return `Stake ${amount} of the chain's staking asset through ${p.name} and keep the receipt.`;
  }
  if (matches('perpetual', 'derivative')) {
    return `Deposit ${amount} of USDC as margin on ${p.name} and open one small hedge.`;
  }
  if (matches('prediction')) {
    return `Fund ${amount} and place one market position on ${p.name}.`;
  }
  if (matches('curator', 'allocator')) {
    return `Deposit ${amount} into a ${p.name} vault on ${chain} and keep the shares.`;
  }
  if (matches('stable')) {
    return `Mint or deposit ${amount} of the stable asset through ${p.name} on ${chain}.`;
  }
  if (matches('rwa')) {
    return `Mint ${amount} of the protocol's yield asset on ${chain} and hold it.`;
  }
  if (matches('insurance')) {
    return `Buy ${amount} of cover from ${p.name} on ${chain} and keep the policy.`;
  }
  return `Deposit ${amount} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

export function farmSteps(
  p: SnapshotProtocol,
  age: number | null,
): FarmStep[] {
  const capital = capitalFor(p);
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);

  return [
    {
      text: 'Create a fresh wallet and write down its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `Get $${capital} of USDC onto ${chain} by bridging or withdrawing from an exchange.`,
      cost: `${gas} of gas on ${chain} plus about $1–3 in bridge fees`,
      time: '10 to 20 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: 'Perform one qualifying action each week: deposit, borrow, swap or vote.',
      cost: `about ${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: "Check the protocol's own points or rewards page each week and claim only from the link it publishes; never pay to claim.",
      cost: 'no fee to check',
      time: '5 minutes a week',
    },
    {
      text: 'Keep a farm log with the wallet, dates and every transaction, plus an unwind plan: withdraw in reverse order and keep a gas reserve.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

export function stepText(step: FarmStep): string {
  const value = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  return (value.length > 600 ? `${value.slice(0, 596)}...` : value).padEnd(
    20,
    ' ',
  );
}

function scoreBoard(
  snapshot: Snapshot,
  model: ModelConstants,
  comparison: ReturnType<typeof calibrationFor>,
): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();

  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (
      !chosen.has(p.slug) &&
      p.tvl_usd < snapshot.floor_usd &&
      isRankable(p)
    ) {
      chosen.set(p.slug, p);
    }
  }

  const tilts = new Map(
    comparison.calibration.map((row) => [row.category, row.tilt]),
  );

  return [...chosen.values()]
    .map((p) => {
      const tilt = tilts.get(categoryKey(p)) ?? 1;
      const value = impliedValue(
        p,
        snapshot.as_of,
        model,
        comparison.globalMultiple,
        tilt,
      );
      return { p, tilt, value };
    })
    .sort(
      (a, b) =>
        b.value.implied - a.value.implied ||
        compareText(a.p.slug, b.p.slug),
    )
    .map(({ p, tilt, value }, index): BoardRow => ({
      ...p,
      chains: [...p.chains],
      rank: index + 1,
      token_status: 'pre-token',
      age_days: value.age,
      implied_value_usd: value.implied,
      model: {
        base_multiple: comparison.globalMultiple,
        category_tilt: tilt,
        growth_pct: value.growthPct,
        growth_multiplier: value.growthMult,
        maturity_multiplier: value.maturityMult,
        breadth_multiplier: value.breadthMult,
        age_days: value.age,
      },
      farm_steps: farmSteps(p, value.age).map(stepText),
    }));
}

export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): BoardRow[] {
  return scoreBoard(snapshot, model, calibrationFor(snapshot, model));
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return liveProtocols(snapshot)
    .sort(
      (a, b) =>
        b.mcap_usd! - a.mcap_usd! ||
        b.tvl_usd - a.tvl_usd ||
        compareText(a.slug, b.slug),
    )
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const comparison = calibrationFor(snapshot, model);
  const board = scoreBoard(snapshot, model, comparison);
  const watchlist = new Set(snapshot.watchlist);
  const live = liveRows(snapshot);
  const rows: RadarRow[] = board.map((row) => ({
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: [...row.chains],
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    category_tilt: row.model.category_tilt,
    base_multiple: row.model.base_multiple,
  }));

  return {
    board,
    radar: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model: { ...model },
      model_version: MODEL_VERSION,
      global_multiple: comparison.globalMultiple,
      watchlist_size: snapshot.watchlist.length,
      board_size: board.length,
      early_size: rows.filter((row) => !watchlist.has(row.slug)).length,
      live_size: live.length,
      rows,
      live,
      calibration: comparison.calibration,
    },
  };
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SnapshotError(`Snapshot contains invalid JSON: ${detail}`);
  }

  if (!objectValue(parsed)) {
    throw new SnapshotError('Snapshot must be a JSON object.');
  }
  if (
    typeof parsed.as_of !== 'string' ||
    dateMilliseconds(parsed.as_of) === null
  ) {
    throw new SnapshotError('Snapshot as_of must be a valid YYYY-MM-DD date.');
  }
  if (typeof parsed.source !== 'string') {
    throw new SnapshotError('Snapshot source must be a string.');
  }
  if (
    typeof parsed.floor_usd !== 'number' ||
    !Number.isSafeInteger(parsed.floor_usd) ||
    parsed.floor_usd <= 0
  ) {
    throw new SnapshotError('Snapshot floor_usd must be a positive safe integer.');
  }
  if (!Array.isArray(parsed.protocols)) {
    throw new SnapshotError('Snapshot protocols must be an array.');
  }
  if (!Array.isArray(parsed.watchlist)) {
    throw new SnapshotError('Snapshot watchlist must be an array.');
  }

  const seen = new Set<string>();
  const protocols = parsed.protocols.map(
    (entry: unknown, index: number): SnapshotProtocol => {
      const label = `Snapshot protocols[${index}]`;
      if (!objectValue(entry)) {
        throw new SnapshotError(`${label} must be an object.`);
      }
      if (typeof entry.slug !== 'string' || entry.slug.length === 0) {
        throw new SnapshotError(`${label}.slug must be a nonempty string.`);
      }
      if (seen.has(entry.slug)) {
        throw new SnapshotError(`${label}.slug duplicates "${entry.slug}".`);
      }
      seen.add(entry.slug);
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new SnapshotError(`${label}.name must be a nonempty string.`);
      }
      if (
        typeof entry.tvl_usd !== 'number' ||
        !Number.isSafeInteger(entry.tvl_usd) ||
        entry.tvl_usd < 0
      ) {
        throw new SnapshotError(
          `${label}.tvl_usd must be a nonnegative safe integer.`,
        );
      }

      return {
        slug: entry.slug,
        name: entry.name,
        category: optionalString(entry.category),
        chains: Array.isArray(entry.chains)
          ? entry.chains.filter(
              (chain): chain is string => typeof chain === 'string',
            )
          : [],
        tvl_usd: entry.tvl_usd,
        change_7d: optionalNumber(entry.change_7d),
        mcap_usd: optionalNumber(entry.mcap_usd),
        listed_at: optionalString(entry.listed_at),
        gecko_id: optionalString(entry.gecko_id),
        symbol: optionalString(entry.symbol),
      };
    },
  );

  const watchlist = parsed.watchlist.map((slug: unknown, index: number) => {
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new SnapshotError(
        `Snapshot watchlist[${index}] must be a nonempty string.`,
      );
    }
    return slug;
  });

  return {
    as_of: parsed.as_of,
    source: parsed.source,
    floor_usd: parsed.floor_usd,
    protocols,
    watchlist,
  };
}

export function boardIssue(
  board: BoardRow[],
  snapshot: Snapshot,
): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) {
      return `Watchlist slug "${slug}" is missing from the board.`;
    }
  }

  for (let index = 0; index < board.length; index++) {
    const row = board[index]!;
    if (row.rank !== index + 1) {
      return `Row "${row.slug}" has rank ${row.rank}; expected ${index + 1}.`;
    }
    if (
      !Number.isSafeInteger(row.implied_value_usd) ||
      row.implied_value_usd <= 0
    ) {
      return `Row "${row.slug}" has an implied value that is not a positive safe integer.`;
    }
    if (
      index > 0 &&
      row.implied_value_usd > board[index - 1]!.implied_value_usd
    ) {
      return `Row "${row.slug}" has an implied value greater than the previous row.`;
    }
    if (
      !Array.isArray(row.farm_steps) ||
      row.farm_steps.length < 3 ||
      row.farm_steps.length > 12
    ) {
      return `Row "${row.slug}" must have between 3 and 12 farm steps.`;
    }
    if (
      row.farm_steps.some(
        (step) =>
          typeof step !== 'string' || step.length < 20 || step.length > 600,
      )
    ) {
      return `Row "${row.slug}" has a farm step outside 20–600 characters.`;
    }
  }

  if (
    board.length >= 2 &&
    board.every(
      (row) => row.implied_value_usd === board[0]!.implied_value_usd,
    )
  ) {
    return 'All board rows share the same implied value.';
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
