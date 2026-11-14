/**
 * @file The core commands: the ones that mean the same in every session,
 * whatever the backend — the filesystem verbs, the shell's own settings and
 * meta commands (help, notes, debug, timing), and the toys and games shelf.
 * A command that reads CUBE itself registers with the ChRIS backend
 * (`chris/chrisCommands.ts`).
 *
 * The engine registers them itself (`core/dispatch.ts`). A backend registers
 * its own commands beside them and never replaces one of these
 * (docs/backend-neutral.adoc).
 *
 * @module
 */
import { type CommandGroup, type CommandHandler, type EnvelopeHandler, type SessionPiece } from './commandRegistry.js';
import type { AnyCommandDeclaration } from './commandDeclaration.js';
import { builtin_leave, builtin_stopwatch, builtin_timer } from '../builtins/games/chimes.js';
import { builtin_cowsay, builtin_cowthink } from '../builtins/games/cowsay.js';
import { builtin_banner, builtin_figlet } from '../builtins/games/figlet.js';
import { builtin_say, builtin_uptime, builtin_who } from '../builtins/games/lab.js';
import { builtin_lolcat } from '../builtins/games/lolcat.js';
import { builtin_morse } from '../builtins/games/morse.js';
import { builtin_calc, builtin_factor, builtin_primes, builtin_roll, builtin_units } from '../builtins/games/numbers.js';
import { builtin_2048, builtin_hangman, builtin_quiz } from '../builtins/games/play.js';
import { builtin_trek } from '../builtins/games/trek.js';
import { builtin_qr } from '../builtins/games/qr.js';
import { builtin_asciiquarium, builtin_cmatrix, builtin_rain, builtin_sl, builtin_snake, builtin_tetris } from '../builtins/games/show.js';
import { builtin_ddate, builtin_pom, builtin_stardate, builtin_sunrise } from '../builtins/games/sky.js';
import { builtin_grep } from '../builtins/sys/grep.js';
import { builtin_cut, builtin_head, builtin_sort, builtin_tail, builtin_uniq, builtin_wc } from '../builtins/sys/textFilters.js';
import { commandCommand } from '../builtins/sys/command.js';
import { killCommand, waitCommand } from '../builtins/sys/tasks.js';
import { fgCommand, jobletsCommand } from '../builtins/sys/joblets.js';
import { setCommand, unsetCommand } from '../builtins/sys/variables.js';
import { echoCommand, printfCommand } from '../builtins/sys/echo.js';
import { builtin_expect } from '../builtins/res/expect.js';
import { builtin_play } from '../builtins/res/play.js';
import { aproposCommand, manCommand } from '../builtins/sys/apropos.js';
import { builtin_rev, builtin_rot13, builtin_seq, builtin_shuf, builtin_tac, builtin_yes } from '../builtins/games/text.js';
import { builtin_wtf } from '../builtins/games/wtf.js';
import { builtin_debug } from '../builtins/debug.js';
import { builtin_cat } from '../builtins/fs/cat.js';
import { builtin_cd } from '../builtins/fs/cd.js';
import { builtin_cp } from '../builtins/fs/cp.js';
import { lsCommand } from '../builtins/fs/ls.js';
import { builtin_mkdir } from '../builtins/fs/mkdir.js';
import { builtin_mv } from '../builtins/fs/mv.js';
import { builtin_pwd } from '../builtins/fs/pwd.js';
import { builtin_url } from '../builtins/fs/url.js';
import { builtin_rm } from '../builtins/fs/rm.js';
import { builtin_rmdir } from '../builtins/fs/rmdir.js';
import { builtin_touch } from '../builtins/fs/touch.js';
import { builtin_find } from '../builtins/fs/find.js';
import { helpCommand } from '../builtins/help.js';
import { builtin_cal } from '../builtins/sys/cal.js';
import { dateCommand } from '../builtins/sys/date.js';
import { builtin_fortune } from '../builtins/sys/fortune.js';
import { builtin_timing } from '../builtins/sys/timing.js';
import { versionCommand } from '../builtins/sys/version.js';
import { builtin_weather } from '../builtins/sys/weather.js';
import { notesCommand } from '../builtins/sys/notes.js';
import { envelopeHandler_wrap } from './sink.js';

const envelope: Record<string, EnvelopeHandler> = {
  cat: builtin_cat,
  find: builtin_find,
  cd: builtin_cd,
  cp: builtin_cp,
  mv: builtin_mv,
  rm: builtin_rm,
  mkdir: builtin_mkdir,
  rmdir: builtin_rmdir,
  touch: builtin_touch,
  pwd: builtin_pwd,
  url: builtin_url,
  timing: builtin_timing,
  debug: builtin_debug,
  fortune: builtin_fortune,
  cowsay: builtin_cowsay,
  cowthink: builtin_cowthink,
  figlet: builtin_figlet,
  banner: builtin_banner,
  lolcat: builtin_lolcat,
  rev: builtin_rev,
  tac: builtin_tac,
  grep: builtin_grep,
  wc: builtin_wc,
  head: builtin_head,
  tail: builtin_tail,
  sort: builtin_sort,
  uniq: builtin_uniq,
  cut: builtin_cut,
  yes: builtin_yes,
  seq: builtin_seq,
  factor: builtin_factor,
  primes: builtin_primes,
  shuf: builtin_shuf,
  roll: builtin_roll,
  rot13: builtin_rot13,
  morse: builtin_morse,
  calc: builtin_calc,
  units: builtin_units,
  who: builtin_who,
  uptime: builtin_uptime,
  say: builtin_say,
  wtf: builtin_wtf,
  qr: builtin_qr,
  pom: builtin_pom,
  stardate: builtin_stardate,
  ddate: builtin_ddate,
  sunrise: builtin_sunrise,
  timer: builtin_timer,
  expect: builtin_expect,
  play: builtin_play,
  leave: builtin_leave,
  stopwatch: builtin_stopwatch,
  sl: builtin_sl,
  cmatrix: builtin_cmatrix,
  rain: builtin_rain,
  asciiquarium: builtin_asciiquarium,
  tetris: builtin_tetris,
  snake: builtin_snake,
  quiz: builtin_quiz,
  hangman: builtin_hangman,
  trek: builtin_trek,
  '2048': builtin_2048,
  weather: builtin_weather,
  cal: builtin_cal,
};

const plain: Record<string, CommandHandler> = {
  cd: envelopeHandler_wrap(builtin_cd),
  pwd: envelopeHandler_wrap(builtin_pwd),
  url: envelopeHandler_wrap((args: string[]) => builtin_url(args)),
  cat: envelopeHandler_wrap(builtin_cat),
  find: envelopeHandler_wrap(builtin_find),
  rm: envelopeHandler_wrap(builtin_rm),
  cp: envelopeHandler_wrap(builtin_cp),
  mv: envelopeHandler_wrap(builtin_mv),
  touch: envelopeHandler_wrap(builtin_touch),
  mkdir: envelopeHandler_wrap(builtin_mkdir),
  rmdir: envelopeHandler_wrap(builtin_rmdir),
  timing: envelopeHandler_wrap(builtin_timing),
  debug: envelopeHandler_wrap(builtin_debug),
  fortune: envelopeHandler_wrap(builtin_fortune),
  cowsay: envelopeHandler_wrap(builtin_cowsay),
  cowthink: envelopeHandler_wrap(builtin_cowthink),
  figlet: envelopeHandler_wrap(builtin_figlet),
  banner: envelopeHandler_wrap(builtin_banner),
  lolcat: envelopeHandler_wrap(builtin_lolcat),
  rev: envelopeHandler_wrap(builtin_rev),
  tac: envelopeHandler_wrap(builtin_tac),
  grep: envelopeHandler_wrap(builtin_grep),
  wc: envelopeHandler_wrap(builtin_wc),
  head: envelopeHandler_wrap(builtin_head),
  tail: envelopeHandler_wrap(builtin_tail),
  sort: envelopeHandler_wrap(builtin_sort),
  uniq: envelopeHandler_wrap(builtin_uniq),
  cut: envelopeHandler_wrap(builtin_cut),
  yes: envelopeHandler_wrap(builtin_yes),
  seq: envelopeHandler_wrap(builtin_seq),
  factor: envelopeHandler_wrap(builtin_factor),
  primes: envelopeHandler_wrap(builtin_primes),
  shuf: envelopeHandler_wrap(builtin_shuf),
  roll: envelopeHandler_wrap(builtin_roll),
  rot13: envelopeHandler_wrap(builtin_rot13),
  morse: envelopeHandler_wrap(builtin_morse),
  calc: envelopeHandler_wrap(builtin_calc),
  units: envelopeHandler_wrap(builtin_units),
  who: envelopeHandler_wrap(builtin_who),
  uptime: envelopeHandler_wrap(builtin_uptime),
  say: envelopeHandler_wrap(builtin_say),
  wtf: envelopeHandler_wrap(builtin_wtf),
  qr: envelopeHandler_wrap(builtin_qr),
  pom: envelopeHandler_wrap(builtin_pom),
  stardate: envelopeHandler_wrap(builtin_stardate),
  ddate: envelopeHandler_wrap(builtin_ddate),
  sunrise: envelopeHandler_wrap(builtin_sunrise),
  timer: envelopeHandler_wrap(builtin_timer),
  expect: envelopeHandler_wrap(builtin_expect),
  play: envelopeHandler_wrap(builtin_play),
  leave: envelopeHandler_wrap(builtin_leave),
  stopwatch: envelopeHandler_wrap(builtin_stopwatch),
  sl: envelopeHandler_wrap(builtin_sl),
  cmatrix: envelopeHandler_wrap(builtin_cmatrix),
  rain: envelopeHandler_wrap(builtin_rain),
  asciiquarium: envelopeHandler_wrap(builtin_asciiquarium),
  tetris: envelopeHandler_wrap(builtin_tetris),
  snake: envelopeHandler_wrap(builtin_snake),
  quiz: envelopeHandler_wrap(builtin_quiz),
  hangman: envelopeHandler_wrap(builtin_hangman),
  trek: envelopeHandler_wrap(builtin_trek),
  '2048': envelopeHandler_wrap(builtin_2048),
  weather: envelopeHandler_wrap(builtin_weather),
  cal: envelopeHandler_wrap(builtin_cal),
};


/** The core commands: their handlers. Their help is registered from `builtins/help.ts`, which holds it. */
/**
 * What the core's commands hold of the session: a read holds nothing and
 * runs beside anything; `cd` holds the working directory. A command not
 * named holds the whole session (a game, a play, anything that asks).
 */
const holds: Record<string, readonly SessionPiece[]> = {
  ...Object.fromEntries([
    'banner', 'cal', 'calc', 'cat', 'cowsay', 'cowthink', 'cut', 'ddate', 'factor',
    'figlet', 'find', 'fortune', 'grep', 'head', 'lolcat', 'morse', 'pom',
    'primes', 'pwd', 'qr', 'rev', 'rot13', 'seq', 'sort', 'stardate', 'tac', 'tail', 'uniq',
    'units', 'uptime', 'wc', 'who',
  ].map((name: string): [string, readonly SessionPiece[]] => [name, []])),
  cd: ['cwd'],
};

/** The core commands declared in one record each: grammar, kinds, handler, holds and help together. */
const declarations: ReadonlyArray<AnyCommandDeclaration> = [
  lsCommand,
  // General, in the order their handlers listed before they were declared.
  commandCommand, aproposCommand, manCommand, killCommand, waitCommand, fgCommand, jobletsCommand,
  setCommand, echoCommand, printfCommand, unsetCommand, versionCommand, notesCommand, dateCommand, helpCommand,
];

export const coreCommands: CommandGroup = {
  envelope,
  plain,
  holds,
  declarations,
};
