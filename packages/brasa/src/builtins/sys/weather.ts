import { CommandEnvelope, envelope_error, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
/**
 * @file Builtin weather.
 *
 * Reports the weather at a place — the current conditions and the next few
 * days — from Open-Meteo, which needs no key and no account. A place is
 * geocoded by name through the same service, so `weather Boston` and
 * `weather Cape Town` both work, and a bare `weather` asks about Boston,
 * where the lab is — in metric, as the lab reads, unless `--units imperial`.
 *
 * The report is a kernel fact like `date` or `fortune`: it renders once and
 * every surface shows the same text, and the typed model beneath it carries
 * the numbers for a surface that wants to draw them differently. The
 * network reached is the daemon's, so a host that cannot see the internet
 * says so in one line rather than hanging.
 *
 * @module
 */

/** Where `weather` looks when given no place. */
export const WEATHER_DEFAULT_PLACE: string = 'Boston';

/** Days of forecast shown when none are asked for. */
const DAYS_DEFAULT: number = 3;

/** The two unit systems `--units` takes. */
export type WeatherUnits = 'metric' | 'imperial';

/** The system used when none is asked for: the lab reports in metric. */
export const WEATHER_UNITS_DEFAULT: WeatherUnits = 'metric';

/** The most forecast days Open-Meteo answers. */
const DAYS_MAX: number = 16;

/** How long one call may take before the report gives up. */
const FETCH_TIMEOUT_MS: number = 8_000;

/** The geocoder: a name to coordinates. */
const GEOCODE_URL: string = 'https://geocoding-api.open-meteo.com/v1/search';

/** The forecast itself. */
const FORECAST_URL: string = 'https://api.open-meteo.com/v1/forecast';

/**
 * A fetch the report goes through — the global one in a daemon, a stub in
 * a test.
 */
export type WeatherFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The compass, eight points, clockwise from north. */
const COMPASS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** WMO weather interpretation codes, as Open-Meteo reports them, in words. */
const CONDITIONS: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  85: 'light snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with light hail',
  99: 'thunderstorm with heavy hail',
};

/** A place the geocoder answered with. */
export interface WeatherPlace {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** The conditions now. */
export interface WeatherNow {
  time: string;
  temperature: number;
  apparent: number;
  humidity: number;
  code: number;
  condition: string;
  windSpeed: number;
  windDirection: string;
}

/** One day of the forecast. */
export interface WeatherDay {
  date: string;
  low: number;
  high: number;
  code: number;
  condition: string;
}

/** The report, as the model beneath the rendered text. */
export interface WeatherReport {
  place: WeatherPlace;
  units: 'F' | 'C';
  now: WeatherNow;
  days: WeatherDay[];
}

/** What the geocoder answers, as much of it as the report reads. */
interface GeocodeAnswer {
  results?: Array<{
    name?: unknown;
    admin1?: unknown;
    country?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timezone?: unknown;
  }>;
}

/** What the forecast answers, as much of it as the report reads. */
interface ForecastAnswer {
  current?: {
    time?: unknown;
    temperature_2m?: unknown;
    apparent_temperature?: unknown;
    relative_humidity_2m?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
  };
  daily?: {
    time?: unknown;
    temperature_2m_max?: unknown;
    temperature_2m_min?: unknown;
    weather_code?: unknown;
  };
}

/**
 * Words a WMO weather code.
 *
 * @param code - The code Open-Meteo reported.
 * @returns The condition in words; an unknown code says so with its number.
 */
export function condition_resolve(code: number): string {
  return CONDITIONS[code] ?? `conditions code ${code}`;
}

/**
 * Names a wind direction on the eight-point compass.
 *
 * @param degrees - Where the wind comes from, degrees clockwise from north.
 * @returns The compass point.
 */
export function compass_convertFromDegrees(degrees: number): string {
  const index: number = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return COMPASS[index];
}

/**
 * Reads a number out of an untyped JSON field.
 *
 * @param value - The field.
 * @returns The number, or null when the field is not one.
 */
function number_read(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads a string out of an untyped JSON field.
 *
 * @param value - The field.
 * @returns The string, or the empty string when the field is not one.
 */
function string_read(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Fetches one JSON answer, bounded in time.
 *
 * @param fetchFn - The fetch to go through.
 * @param url - What to ask.
 * @returns The parsed body.
 * @throws {Error} When the service is unreachable, answers an error, or
 *   answers something that is not JSON.
 */
async function json_fetch(fetchFn: WeatherFetch, url: string): Promise<unknown> {
  const response: Response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`open-meteo answered ${response.status}`);
  return response.json();
}

/**
 * Finds a place by name.
 *
 * @param fetchFn - The fetch to go through.
 * @param name - The place as the operator typed it.
 * @returns The first place the geocoder offers, or null when it offers none.
 */
export async function place_find(fetchFn: WeatherFetch, name: string): Promise<WeatherPlace | null> {
  const url: string = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const answer: GeocodeAnswer = (await json_fetch(fetchFn, url)) as GeocodeAnswer;
  const first = answer.results?.[0];
  const latitude: number | null = number_read(first?.latitude);
  const longitude: number | null = number_read(first?.longitude);
  if (first === undefined || latitude === null || longitude === null) return null;
  return {
    name: string_read(first.name),
    region: string_read(first.admin1),
    country: string_read(first.country),
    latitude,
    longitude,
    timezone: string_read(first.timezone) || 'auto',
  };
}

/**
 * Fetches the conditions at a place.
 *
 * @param fetchFn - The fetch to go through.
 * @param place - Where.
 * @param units - Metric (°C, km/h) or imperial (°F, mph).
 * @param days - How many days of forecast.
 * @returns The report.
 * @throws {Error} When the service cannot be reached or answers without the
 *   fields a report is made of.
 */
export async function report_fetch(
  fetchFn: WeatherFetch,
  place: WeatherPlace,
  units: WeatherUnits,
  days: number,
): Promise<WeatherReport> {
  const celsius: boolean = units === 'metric';
  const query: string = [
    `latitude=${place.latitude}`,
    `longitude=${place.longitude}`,
    'current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
    'daily=weather_code,temperature_2m_max,temperature_2m_min',
    `temperature_unit=${celsius ? 'celsius' : 'fahrenheit'}`,
    `wind_speed_unit=${celsius ? 'kmh' : 'mph'}`,
    `timezone=${encodeURIComponent(place.timezone)}`,
    `forecast_days=${days}`,
  ].join('&');
  const answer: ForecastAnswer = (await json_fetch(fetchFn, `${FORECAST_URL}?${query}`)) as ForecastAnswer;
  const current = answer.current;
  const temperature: number | null = number_read(current?.temperature_2m);
  const code: number | null = number_read(current?.weather_code);
  if (current === undefined || temperature === null || code === null) {
    throw new Error('open-meteo answered without current conditions');
  }
  const now: WeatherNow = {
    time: string_read(current.time),
    temperature,
    apparent: number_read(current.apparent_temperature) ?? temperature,
    humidity: number_read(current.relative_humidity_2m) ?? 0,
    code,
    condition: condition_resolve(code),
    windSpeed: number_read(current.wind_speed_10m) ?? 0,
    windDirection: compass_convertFromDegrees(number_read(current.wind_direction_10m) ?? 0),
  };
  const dates: unknown[] = Array.isArray(answer.daily?.time) ? answer.daily.time : [];
  const highs: unknown[] = Array.isArray(answer.daily?.temperature_2m_max) ? answer.daily.temperature_2m_max : [];
  const lows: unknown[] = Array.isArray(answer.daily?.temperature_2m_min) ? answer.daily.temperature_2m_min : [];
  const codes: unknown[] = Array.isArray(answer.daily?.weather_code) ? answer.daily.weather_code : [];
  const forecast: WeatherDay[] = [];
  for (let i: number = 0; i < dates.length; i++) {
    const high: number | null = number_read(highs[i]);
    const low: number | null = number_read(lows[i]);
    const dayCode: number | null = number_read(codes[i]);
    if (high === null || low === null || dayCode === null) continue;
    forecast.push({ date: string_read(dates[i]), low, high, code: dayCode, condition: condition_resolve(dayCode) });
  }
  return { place, units: celsius ? 'C' : 'F', now, days: forecast };
}

/**
 * Names a forecast day: `today`, then the weekday and date.
 *
 * @param date - The day as `YYYY-MM-DD`.
 * @param index - Its position in the forecast, 0 being today.
 * @returns The label.
 */
function day_label(date: string, index: number): string {
  if (index === 0) return 'today';
  const parsed: Date = new Date(`${date}T12:00:00Z`);
  const weekday: string = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()] ?? '';
  return `${weekday} ${date.slice(5)}`;
}

/**
 * Renders a report as the lines a terminal shows.
 *
 * @param report - The report.
 * @returns The text, with a trailing newline.
 */
export function report_render(report: WeatherReport): string {
  const unit: string = `°${report.units}`;
  const speed: string = report.units === 'C' ? 'km/h' : 'mph';
  const where: string = [report.place.name, report.place.region, report.place.country]
    .filter((part: string): boolean => part.length > 0)
    .join(', ');
  const when: string = report.now.time.replace('T', ' ');
  const lines: string[] = [
    `${where} · ${when}`,
    `  now       ${Math.round(report.now.temperature)}${unit} (feels ${Math.round(report.now.apparent)}${unit}) · ${report.now.condition} · wind ${Math.round(report.now.windSpeed)} ${speed} ${report.now.windDirection} · humidity ${Math.round(report.now.humidity)}%`,
  ];
  report.days.forEach((day: WeatherDay, index: number): void => {
    lines.push(`  ${day_label(day.date, index).padEnd(9)} ${Math.round(day.low)}–${Math.round(day.high)}${unit} · ${day.condition}`);
  });
  return `${lines.join('\n')}\n`;
}


/** What a `weather` line may hold. */
const WEATHER_GRAMMAR = {
  operands: [{ name: 'place', kind: 'word', optional: true, repeat: true, summary: 'The place, in as many words as it takes (default Boston)' }],
  options: {
    units: { short: 'u', long: 'units', summary: 'metric (default: °C, km/h) or imperial (°F, mph)', value: { name: 'system', kind: 'enum', values: ['metric', 'imperial'] } },
    days: { short: 'd', long: 'days', summary: 'Days of forecast to show (default 3, at most 16)', value: { name: 'N', kind: 'int', min: 1, max: DAYS_MAX } },
  },
} as const satisfies CommandGrammar;

/**
 * `weather [place] [-u|--units metric|imperial] [-d|--days N]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [weatherCommand] });
 * ```
 */
export const weatherCommand = command_declare({
  name: 'weather',
  grammar: WEATHER_GRAMMAR,
  help: {
    summary: 'The weather at a place, now and the next few days',
    description: 'Reports the current conditions and a short forecast for a place, from Open-Meteo (no key, no account). The place is found by name; with none given it is Boston. Metric (°C, km/h) unless --units imperial asks for °F and mph. The call is made from the session host, so it needs that host to reach the internet.',
    examples: ['weather', 'weather Cape Town', 'weather Boston --units imperial', 'weather Paris -d 7'],
    category: 'Games',
  },
  handler: async (args: CommandArguments<typeof WEATHER_GRAMMAR>): Promise<CommandEnvelope> => weather_run(args, fetch_global),
});

/**
 * The global fetch, as the report goes through it unless a test hands in its own.
 *
 * @param url - What to ask.
 * @param init - The request's options.
 * @returns The answer.
 *
 * @example
 * ```ts
 * const answer: Response = await fetch_global('https://example.org');
 * ```
 */
function fetch_global(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/**
 * Reports the weather at a place.
 *
 * @param args - `[place…] [-u|--units metric|imperial] [-d|--days N]`.
 * @param fetchFn - The fetch to go through; the global one unless a test
 *   hands in its own.
 * @returns An envelope carrying the rendered report and the typed report
 *   beneath it; an error envelope when a flag is unknown, the place is not
 *   found, or the service cannot be reached.
 *
 * @example
 * ```ts
 * await builtin_weather(['Paris', '-d', '7']);
 * ```
 */
export async function builtin_weather(args: string[], fetchFn: WeatherFetch = fetch_global): Promise<CommandEnvelope> {
  return declaredCommand_run({ ...weatherCommand, handler: (typed: CommandArguments<typeof WEATHER_GRAMMAR>): Promise<CommandEnvelope> => weather_run(typed, fetchFn) }, args);
}

/**
 * Reports the weather for a line already parsed.
 *
 * @param args - The typed line.
 * @param fetchFn - The fetch to go through.
 * @returns The report, or an error envelope when the place is not found or the service cannot be reached.
 *
 * @example
 * ```ts
 * await weather_run({ subcommand: null, operands: { place: ['Paris'] }, options: { units: undefined, days: 7 }, expanded: {} }, fetch);
 * ```
 */
export async function weather_run(args: CommandArguments<typeof WEATHER_GRAMMAR>, fetchFn: WeatherFetch): Promise<CommandEnvelope> {
  const placeName: string = args.operands.place.length > 0 ? args.operands.place.join(' ') : WEATHER_DEFAULT_PLACE;
  const units: WeatherUnits = args.options.units ?? WEATHER_UNITS_DEFAULT;
  const days: number = args.options.days ?? DAYS_DEFAULT;
  try {
    const place: WeatherPlace | null = await place_find(fetchFn, placeName);
    if (place === null) return envelope_error(`weather: no such place '${placeName}'\n`);
    const report: WeatherReport = await report_fetch(fetchFn, place, units, days);
    return envelope_ok(report_render(report), { kind: 'sys.weather', data: report });
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    return envelope_error(`weather: ${reason}\n`);
  }
}
