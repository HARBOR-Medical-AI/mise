/**
 * @file Time and sky from the shelf: `pom`, `stardate`, `ddate`, `sunrise`.
 *
 * `pom` is BSD's phase of the moon; `stardate` reckons the day two ways;
 * `ddate` is the Discordian calendar, holy days included; `sunrise` asks
 * Open-Meteo (the service `weather` already uses, no key) when the sun
 * rises and sets at a place.
 *
 * @module
 */
import chalk from 'chalk';
import { WEATHER_DEFAULT_PLACE, place_find, type WeatherFetch, type WeatherPlace } from '../sys/weather.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandDeclaration, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/* --------------------------------------------------------------- moon */

/** A reference new moon: 2000-01-06 18:14 UTC, as a Julian day. */
const NEW_MOON_JD: number = 2451550.1;
/** The synodic month, in days. */
const SYNODIC_DAYS: number = 29.530588853;

/** A date as a Julian day. */
export function julianDay_compute(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** The moon's state on a date. */
export interface MoonPhase {
  /** 0 at new, 0.5 at full, in [0, 1). */
  phase: number;
  /** The lit fraction, 0..1. */
  illumination: number;
  /** The phase's name. */
  name: string;
  /** Days to the next full moon and the next new moon. */
  toFull: number;
  toNew: number;
}

/** Where the moon stands on a date. */
export function moon_phase(date: Date): MoonPhase {
  const cycles: number = (julianDay_compute(date) - NEW_MOON_JD) / SYNODIC_DAYS;
  const phase: number = cycles - Math.floor(cycles);
  const illumination: number = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const near = (p: number): boolean => Math.abs(phase - p) < 0.034 || Math.abs(phase - p - 1) < 0.034;
  const name: string = near(0) ? 'New Moon' : near(0.25) ? 'First Quarter' : near(0.5) ? 'Full Moon' : near(0.75) ? 'Last Quarter'
    : phase < 0.25 ? 'Waxing Crescent' : phase < 0.5 ? 'Waxing Gibbous' : phase < 0.75 ? 'Waning Gibbous' : 'Waning Crescent';
  const toFull: number = ((0.5 - phase + 1) % 1) * SYNODIC_DAYS;
  const toNew: number = ((1 - phase) % 1) * SYNODIC_DAYS;
  return { phase, illumination, name, toFull, toNew };
}

/** A small moon, lit from the side the phase lights. */
export function moon_draw(phase: MoonPhase): string[] {
  const lit: number = phase.illumination;
  const waxing: boolean = phase.phase < 0.5;
  const rows: string[] = [];
  const radius: number = 4;
  for (let y: number = -radius; y <= radius; y++) {
    let row: string = '';
    for (let x: number = -radius * 2; x <= radius * 2; x++) {
      const dx: number = x / 2;
      const inside: boolean = dx * dx + y * y <= radius * radius + 0.5;
      if (!inside) { row += ' '; continue; }
      const half: number = Math.sqrt(Math.max(0, radius * radius - y * y));
      // The terminator: a chord moving across the disc as the phase goes.
      const edge: number = (1 - 2 * lit) * half;
      const bright: boolean = waxing ? dx >= edge : dx <= -edge;
      row += bright ? '@' : '.';
    }
    rows.push(row.trimEnd());
  }
  return rows;
}

/**
 * Reads a date out of the words a command was given.
 *
 * @param words - The date's words, none for today.
 * @returns The date; invalid when the words are not one.
 */
function date_read(words: readonly string[]): Date {
  return words.length > 0 ? new Date(words.join(' ')) : new Date();
}

/** What `pom` takes: a date, in as many words as it is written. */
const POM_GRAMMAR = {
  operands: [{ name: 'date', kind: 'word', optional: true, repeat: true, summary: 'The date to look at (default: today)' }],
} as const satisfies CommandGrammar;

/**
 * `pom [date]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pomCommand] });
 * ```
 */
export const pomCommand = command_declare({
  name: 'pom',
  grammar: POM_GRAMMAR,
  help: {
    summary: 'The phase of the moon',
    description: "BSD's pom: the Moon's phase today (or on a date), how much of it is lit, the days to the next full and new moons, and a small moon drawn as it looks.",
    examples: ['pom', 'pom 2026-12-25'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof POM_GRAMMAR>): Promise<CommandEnvelope> => pom_run(args.operands.date),
});

/**
 * `pom` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `pom`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_pom(['2026-12-25']);
 * ```
 */
export async function builtin_pom(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(pomCommand, args);
}

/**
 * Runs `pom` on a date.
 *
 * @param words - The date's words, none for today.
 * @returns The answer, or a refusal for words that are not a date.
 *
 * @example
 * ```ts
 * await pom_run(['2026-12-25']);
 * ```
 */
export async function pom_run(words: readonly string[]): Promise<CommandEnvelope> {
  const date: Date = date_read(words);
  if (Number.isNaN(date.getTime())) return envelope_error('', undefined, `pom: '${words.join(' ')}' is not a date (try pom 2026-12-25)\n`);
  const moon: MoonPhase = moon_phase(date);
  const percent: number = Math.round(moon.illumination * 100);
  const trend: string = moon.name === 'Full Moon' || moon.name === 'New Moon' ? '' : moon.phase < 0.5 ? ' (waxing)' : ' (waning)';
  const lines: string[] = [
    `The Moon is ${chalk.bold(moon.name)}${trend}: ${percent}% of the Full`,
    `${chalk.gray(`next full moon in ${moon.toFull.toFixed(1)} days, next new moon in ${moon.toNew.toFixed(1)} days`)}`,
    ...moon_draw(moon).map((row: string): string => `   ${row}`),
  ];
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.pom', data: { date: date.toISOString(), ...moon } });
}

/* ----------------------------------------------------------- stardate */

/** Days into the year, 1-based, and the year's length. */
function yearDay_compute(date: Date): { day: number; days: number; fraction: number } {
  const start: number = Date.UTC(date.getUTCFullYear(), 0, 1);
  const next: number = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  const elapsed: number = date.getTime() - start;
  const days: number = Math.round((next - start) / 86_400_000);
  return { day: Math.floor(elapsed / 86_400_000) + 1, days, fraction: elapsed / (next - start) };
}

/** The stardate two ways: the Kelvin films' `YYYY.DDD`, and TNG's thousand-per-year from 2323. */
export function stardate_derive(date: Date): { kelvin: string; tng: string } {
  const { day, fraction } = yearDay_compute(date);
  const year: number = date.getUTCFullYear();
  const kelvin: string = `${year}.${String(day).padStart(3, '0')}`;
  const tng: number = (year - 2323) * 1000 + fraction * 1000;
  return { kelvin, tng: tng.toFixed(1) };
}

/** What `stardate` takes: a date, in as many words as it is written. */
const STARDATE_GRAMMAR = {
  operands: [{ name: 'date', kind: 'word', optional: true, repeat: true, summary: 'The date to reckon (default: today)' }],
} as const satisfies CommandGrammar;

/**
 * `stardate [date]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [stardateCommand] });
 * ```
 */
export const stardateCommand = command_declare({
  name: 'stardate',
  grammar: STARDATE_GRAMMAR,
  help: {
    summary: 'The stardate, two ways',
    description: "The day as a stardate: by the Kelvin films' reckoning (the year, then the day of it), with TNG's thousand-a-year count from 2323 beside it.",
    examples: ['stardate', 'stardate 2366-01-01'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof STARDATE_GRAMMAR>): Promise<CommandEnvelope> => stardate_run(args.operands.date),
});

/**
 * `stardate` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `stardate`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_stardate(['2366-01-01']);
 * ```
 */
export async function builtin_stardate(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(stardateCommand, args);
}

/**
 * Runs `stardate` on a date.
 *
 * @param words - The date's words, none for today.
 * @returns The answer, or a refusal for words that are not a date.
 *
 * @example
 * ```ts
 * await stardate_run(['2366-01-01']);
 * ```
 */
export async function stardate_run(words: readonly string[]): Promise<CommandEnvelope> {
  const date: Date = date_read(words);
  if (Number.isNaN(date.getTime())) return envelope_error('', undefined, `stardate: '${words.join(' ')}' is not a date\n`);
  const sd = stardate_derive(date);
  const lines: string[] = [
    `Stardate ${chalk.bold(sd.kelvin)}`,
    chalk.gray(`(Kelvin reckoning: the year and the day of it; by TNG's count it is ${sd.tng} — that era is still ahead of us)`),
  ];
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.stardate', data: { date: date.toISOString(), ...sd } });
}

/* -------------------------------------------------------------- ddate */

const SEASONS: ReadonlyArray<string> = ['Chaos', 'Discord', 'Confusion', 'Bureaucracy', 'The Aftermath'];
const WEEKDAYS: ReadonlyArray<string> = ['Sweetmorn', 'Boomtime', 'Pungenday', 'Prickle-Prickle', 'Setting Orange'];
const APOSTLE_DAYS: ReadonlyArray<string> = ['Mungday', 'Mojoday', 'Syaday', 'Zaraday', 'Maladay'];
const SEASON_DAYS: ReadonlyArray<string> = ['Chaoflux', 'Discoflux', 'Confuflux', 'Bureflux', 'Afflux'];

/** The Discordian date of a Gregorian one. */
export interface DiscordianDate {
  yold: number;
  season: string;
  day: number;
  weekday: string;
  holyday: string | null;
  tibs: boolean;
}

export function ddate_derive(date: Date): DiscordianDate {
  const year: number = date.getFullYear();
  const yold: number = year + 1166;
  const start: Date = new Date(year, 0, 1);
  const doy: number = Math.round((new Date(year, date.getMonth(), date.getDate()).getTime() - start.getTime()) / 86_400_000) + 1;
  const leap: boolean = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (leap && doy === 60) return { yold, season: 'Chaos', day: 0, weekday: '', holyday: "St. Tib's Day", tibs: true };
  const adjusted: number = leap && doy > 60 ? doy - 1 : doy;
  const season: number = Math.floor((adjusted - 1) / 73);
  const day: number = ((adjusted - 1) % 73) + 1;
  const weekday: string = WEEKDAYS[(adjusted - 1) % 5] as string;
  const holyday: string | null = day === 5 ? (APOSTLE_DAYS[season] as string) : day === 50 ? (SEASON_DAYS[season] as string) : null;
  return { yold, season: SEASONS[season] as string, day, weekday, holyday, tibs: false };
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal_format(n: number): string {
  const rest: number = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** What `ddate` takes: a date, in as many words as it is written. */
const DDATE_GRAMMAR = {
  operands: [{ name: 'date', kind: 'word', optional: true, repeat: true, summary: 'The date to convert (default: today)' }],
} as const satisfies CommandGrammar;

/**
 * `ddate [date]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [ddateCommand] });
 * ```
 */
export const ddateCommand = command_declare({
  name: 'ddate',
  grammar: DDATE_GRAMMAR,
  help: {
    summary: 'The Discordian date',
    description: "Today in the Discordian calendar: five seasons of 73 days, a five-day week, St. Tib's Day in a leap year, and the holy days called out. Hail Eris.",
    examples: ['ddate', 'ddate 2028-02-29'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof DDATE_GRAMMAR>): Promise<CommandEnvelope> => ddate_run(args.operands.date),
});

/**
 * `ddate` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `ddate`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_ddate(['2028-02-29']);
 * ```
 */
export async function builtin_ddate(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(ddateCommand, args);
}

/**
 * Runs `ddate` on a date.
 *
 * @param words - The date's words, none for today.
 * @returns The answer, or a refusal for words that are not a date.
 *
 * @example
 * ```ts
 * await ddate_run(['2028-02-29']);
 * ```
 */
export async function ddate_run(words: readonly string[]): Promise<CommandEnvelope> {
  const date: Date = date_read(words);
  if (Number.isNaN(date.getTime())) return envelope_error('', undefined, `ddate: '${words.join(' ')}' is not a date\n`);
  const d: DiscordianDate = ddate_derive(date);
  const line: string = d.tibs
    ? `Today is St. Tib's Day in the YOLD ${d.yold}`
    : `Today is ${d.weekday}, the ${ordinal_format(d.day)} day of ${d.season} in the YOLD ${d.yold}${d.holyday === null ? '' : `\nCelebrate ${d.holyday}!`}`;
  return envelope_ok(`${line}\n`, { kind: 'games.ddate', data: { date: date.toISOString(), ...d } });
}

/* ------------------------------------------------------------ sunrise */

const FORECAST_URL: string = 'https://api.open-meteo.com/v1/forecast';
const FETCH_TIMEOUT_MS: number = 8_000;

/** What Open-Meteo says of one day's sun. */
export interface SunDay { date: string; sunrise: string; sunset: string; daylightSeconds: number }

/**
 * Asks Open-Meteo when the sun rises and sets at a place, today and tomorrow.
 *
 * @param fetchFn - The fetch to use.
 * @param place - Where.
 */
export async function sun_fetch(fetchFn: WeatherFetch, place: WeatherPlace): Promise<SunDay[]> {
  const url: string = `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}&daily=sunrise,sunset,daylight_duration&timezone=auto&forecast_days=2`;
  const response: Response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`open-meteo answered ${response.status}`);
  const answer = (await response.json()) as { daily?: { time?: string[]; sunrise?: string[]; sunset?: string[]; daylight_duration?: number[] } };
  const daily = answer.daily ?? {};
  return (daily.time ?? []).map((date: string, i: number): SunDay => ({
    date,
    sunrise: daily.sunrise?.[i] ?? '',
    sunset: daily.sunset?.[i] ?? '',
    daylightSeconds: daily.daylight_duration?.[i] ?? 0,
  }));
}

/** `HH:MM` out of an ISO local time. */
const clock_format = (iso: string): string => iso.slice(11, 16) || '?';

/** What `sunrise` takes: a place, in as many words as it is named. */
const SUNRISE_GRAMMAR = {
  operands: [{ name: 'place', kind: 'word', optional: true, repeat: true, summary: 'The place (default: Boston)' }],
} as const satisfies CommandGrammar;

/** The fetch `sunrise` uses unless handed another. */
const defaultFetch: WeatherFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(url, init);

/**
 * Declares `sunrise` over a fetch (a test hands in its own).
 *
 * @param fetchFn - The fetch the command asks Open-Meteo with.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * const command = sunriseCommand_make(fakeFetch);
 * ```
 */
export function sunriseCommand_make(fetchFn: WeatherFetch): CommandDeclaration<typeof SUNRISE_GRAMMAR> {
  return command_declare({
    name: 'sunrise',
    grammar: SUNRISE_GRAMMAR,
    help: {
      summary: 'When the sun rises and sets at a place',
      description: "Asks Open-Meteo (the service weather uses; no key) for sunrise, sunset and the length of the day at a place, today and tomorrow, in the place's own time. Boston when no place is named. Needs the session host to reach the internet.",
      examples: ['sunrise', 'sunrise Cape Town', 'sunrise Tromsø'],
    },
    handler: async (args: CommandArguments<typeof SUNRISE_GRAMMAR>): Promise<CommandEnvelope> => sunrise_run(args.operands.place, fetchFn),
  });
}

/**
 * `sunrise [place]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [sunriseCommand] });
 * ```
 */
export const sunriseCommand: CommandDeclaration<typeof SUNRISE_GRAMMAR> = sunriseCommand_make(defaultFetch);

/**
 * `sunrise` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `sunrise`.
 * @param fetchFn - The fetch to use.
 * @returns The sun's days, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_sunrise(['Cape', 'Town']);
 * ```
 */
export async function builtin_sunrise(args: string[], fetchFn: WeatherFetch = defaultFetch): Promise<CommandEnvelope> {
  return declaredCommand_run(fetchFn === defaultFetch ? sunriseCommand : sunriseCommand_make(fetchFn), args);
}

/**
 * When the sun rises and sets at a place, today and tomorrow.
 *
 * @param words - The place's words, none for the default place.
 * @param fetchFn - The fetch to use.
 * @returns The sun's days, or a refusal.
 *
 * @example
 * ```ts
 * await sunrise_run(['Tromsø'], fetch);
 * ```
 */
export async function sunrise_run(words: readonly string[], fetchFn: WeatherFetch): Promise<CommandEnvelope> {
  const name: string = words.length > 0 ? words.join(' ') : WEATHER_DEFAULT_PLACE;
  try {
    const place: WeatherPlace | null = await place_find(fetchFn, name);
    if (place === null) return envelope_error('', undefined, `sunrise: no place called '${name}' that open-meteo knows\n`);
    const days: SunDay[] = await sun_fetch(fetchFn, place);
    if (days.length === 0) return envelope_error('', undefined, `sunrise: open-meteo had no days for ${place.name}\n`);
    const where: string = [place.name, place.region, place.country].filter((p: string): boolean => p.length > 0).join(', ');
    const lines: string[] = [chalk.bold(where)];
    for (const [i, day] of days.entries()) {
      const hours: number = Math.floor(day.daylightSeconds / 3600);
      const minutes: number = Math.round((day.daylightSeconds % 3600) / 60);
      lines.push(`${i === 0 ? 'today   ' : 'tomorrow'} ${day.date}  sunrise ${chalk.yellow(clock_format(day.sunrise))}  sunset ${chalk.yellow(clock_format(day.sunset))}  ${chalk.gray(`${hours}h ${String(minutes).padStart(2, '0')}m of daylight`)}`);
    }
    return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.sunrise', data: { place, days } });
  } catch (error: unknown) {
    return envelope_error('', undefined, `sunrise: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
