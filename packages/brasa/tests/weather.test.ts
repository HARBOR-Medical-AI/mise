import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { WeatherFetch, WeatherReport } from '../src/builtins/sys/weather.js';

// The real cumin graph overflows jest's CommonJS export lexer under ESM;
// the builtin needs only its two envelope makers, so those are stubbed
// the way the other sys builtin suites stub them.
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string) => ({ status: 'error', rendered }),
}));

const { builtin_weather, compass_convertFromDegrees, condition_resolve, report_render, weatherCommand } =
  await import('../src/builtins/sys/weather.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');

/** A geocoder answer for Boston, as Open-Meteo gives it. */
const GEOCODE_BOSTON = {
  results: [{ name: 'Boston', admin1: 'Massachusetts', country: 'United States', latitude: 42.35843, longitude: -71.05977, timezone: 'America/New_York' }],
};

/** A forecast answer in metric, as Open-Meteo gives it. */
const FORECAST_METRIC = {
  current: { time: '2026-09-21T14:00', temperature_2m: 14.6, apparent_temperature: 12.8, relative_humidity_2m: 62, weather_code: 2, wind_speed_10m: 15.1, wind_direction_10m: 310 },
  daily: { time: ['2026-09-21', '2026-09-22', '2026-09-23'], weather_code: [2, 61, 0], temperature_2m_max: [17.3, 15.7, 18.9], temperature_2m_min: [8.9, 10.2, 7.3] },
};

/** The same forecast asked in imperial. */
const FORECAST_IMPERIAL = {
  current: { time: '2026-09-21T14:00', temperature_2m: 58.3, apparent_temperature: 55.1, relative_humidity_2m: 62, weather_code: 2, wind_speed_10m: 9.4, wind_direction_10m: 310 },
  daily: { time: ['2026-09-21', '2026-09-22', '2026-09-23'], weather_code: [2, 61, 0], temperature_2m_max: [63.1, 60.2, 66.0], temperature_2m_min: [48.0, 50.4, 45.2] },
};

/** A fetch that answers from a table of URL prefixes and records what was asked. */
function fetch_stub(answers: Record<string, unknown>, asked: string[] = []): WeatherFetch {
  return async (url: string): Promise<Response> => {
    asked.push(url);
    const key: string | undefined = Object.keys(answers).find((prefix: string): boolean => url.startsWith(prefix));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(answers[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * Parses a weather line against its declaration.
 *
 * @param line - The words after `weather`.
 * @returns The place, units and days it parses to, or the refusal.
 */
async function line_parse(line: string): Promise<{ place: string[]; units: string | undefined; days: number | undefined } | string> {
  const parsed = await commandLine_parse(weatherCommand, shellWords_tokenize(line));
  if (!parsed.ok) return parsed.refusal;
  return { place: parsed.args.operands['place'] as string[], units: parsed.args.options['units'] as string | undefined, days: parsed.args.options['days'] as number | undefined };
}

describe('the weather line', () => {
  it('has no place, units or days with no words', async () => {
    expect(await line_parse('')).toEqual({ place: [], units: undefined, days: undefined });
  });
  it('takes a place in several words, and the units and day flags', async () => {
    expect(await line_parse('Cape Town -u imperial -d 7')).toEqual({ place: ['Cape', 'Town'], units: 'imperial', days: 7 });
    expect(await line_parse('--units=imperial --days 1 Paris')).toEqual({ place: ['Paris'], units: 'imperial', days: 1 });
    expect(await line_parse('--units metric')).toEqual({ place: [], units: 'metric', days: undefined });
  });
  it('refuses an unknown flag by name, a bad unit system, and a bad day count', async () => {
    expect(await line_parse('--celsius')).toMatch(/unrecognized option '--celsius'/);
    expect(await line_parse('--units kelvin')).toMatch(/kelvin/);
    expect(await line_parse('--units')).toMatch(/wants a value/);
    expect(await line_parse('-d lots')).toMatch(/not a whole number/);
    expect(await line_parse('-d 40')).toMatch(/40/);
  });
});


describe('condition_resolve and compass_convertFromDegrees', () => {
  it('words the WMO codes and says an unknown one by number', () => {
    expect(condition_resolve(0)).toBe('clear sky');
    expect(condition_resolve(95)).toBe('thunderstorm');
    expect(condition_resolve(42)).toBe('conditions code 42');
  });
  it('names the eight points', () => {
    expect(compass_convertFromDegrees(0)).toBe('N');
    expect(compass_convertFromDegrees(310)).toBe('NW');
    expect(compass_convertFromDegrees(359)).toBe('N');
    expect(compass_convertFromDegrees(-90)).toBe('W');
  });
});

describe('builtin_weather', () => {
  it('geocodes the place, asks the forecast in metric, and renders now plus the days', async () => {
    const asked: string[] = [];
    const envelope: CommandEnvelope = await builtin_weather([], fetch_stub({ 'https://geocoding-api.open-meteo.com/': GEOCODE_BOSTON, 'https://api.open-meteo.com/': FORECAST_METRIC }, asked));
    expect(envelope.status).toBe('ok');
    expect(asked[0]).toContain('name=Boston');
    expect(asked[1]).toContain('latitude=42.35843');
    expect(asked[1]).toContain('temperature_unit=celsius');
    expect(asked[1]).toContain('wind_speed_unit=kmh');
    expect(asked[1]).toContain('forecast_days=3');
    expect(envelope.rendered).toBe([
      'Boston, Massachusetts, United States · 2026-09-21 14:00',
      '  now       15°C (feels 13°C) · partly cloudy · wind 15 km/h NW · humidity 62%',
      '  today     9–17°C · partly cloudy',
      '  Tue 09-22 10–16°C · light rain',
      '  Wed 09-23 7–19°C · clear sky',
      '',
    ].join('\n'));
    expect(envelope.model?.kind).toBe('sys.weather');
    const report: WeatherReport = envelope.model?.data as WeatherReport;
    expect(report.units).toBe('C');
    expect(report.now.windDirection).toBe('NW');
    expect(report.days).toHaveLength(3);
  });

  it('asks in Fahrenheit and mph when told --units imperial', async () => {
    const asked: string[] = [];
    const envelope: CommandEnvelope = await builtin_weather(['Boston', '--units', 'imperial'], fetch_stub({ 'https://geocoding-api.open-meteo.com/': GEOCODE_BOSTON, 'https://api.open-meteo.com/': FORECAST_IMPERIAL }, asked));
    expect(envelope.status).toBe('ok');
    expect(asked[1]).toContain('temperature_unit=fahrenheit');
    expect(asked[1]).toContain('wind_speed_unit=mph');
    expect(envelope.rendered).toContain('58°F (feels 55°F)');
    expect(envelope.rendered).toContain('wind 9 mph NW');
    expect((envelope.model?.data as WeatherReport).units).toBe('F');
  });

  it('says when the place is not found', async () => {
    const envelope: CommandEnvelope = await builtin_weather(['Nowhereville'], fetch_stub({ 'https://geocoding-api.open-meteo.com/': { results: [] } }));
    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toBe("weather: no such place 'Nowhereville'\n");
  });

  it('says when the service cannot be reached, in one line', async () => {
    const down: WeatherFetch = async (): Promise<Response> => { throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com'); };
    const envelope: CommandEnvelope = await builtin_weather([], down);
    expect(envelope.status).toBe('error');
    expect(envelope.rendered).toBe('weather: getaddrinfo ENOTFOUND api.open-meteo.com\n');
    const refused: CommandEnvelope = await builtin_weather([], fetch_stub({}));
    expect(refused.rendered).toBe('weather: open-meteo answered 404\n');
  });

  it('refuses an unknown flag without asking anyone', async () => {
    const asked: string[] = [];
    const envelope: CommandEnvelope = await builtin_weather(['--metric'], fetch_stub({}, asked));
    expect(envelope.status).toBe('error');
    expect(asked).toHaveLength(0);
  });

  it('renders a report without a region or country', () => {
    const report: WeatherReport = {
      place: { name: 'Atlantis', region: '', country: '', latitude: 0, longitude: 0, timezone: 'UTC' },
      units: 'C',
      now: { time: '2026-01-01T00:00', temperature: 20, apparent: 20, humidity: 50, code: 0, condition: 'clear sky', windSpeed: 0, windDirection: 'N' },
      days: [],
    };
    expect(report_render(report).split('\n')[0]).toBe('Atlantis · 2026-01-01 00:00');
  });
});
