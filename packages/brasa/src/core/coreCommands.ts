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
import { leaveCommand, stopwatchCommand, timerCommand } from '../builtins/games/chimes.js';
import { cowsayCommand, cowthinkCommand } from '../builtins/games/cowsay.js';
import { bannerCommand, figletCommand } from '../builtins/games/figlet.js';
import { sayCommand, uptimeCommand, whoCommand } from '../builtins/games/lab.js';
import { lolcatCommand } from '../builtins/games/lolcat.js';
import { morseCommand } from '../builtins/games/morse.js';
import { calcCommand, factorCommand, primesCommand, rollCommand, unitsCommand } from '../builtins/games/numbers.js';
import { game2048Command, hangmanCommand, quizCommand } from '../builtins/games/play.js';
import { trekCommand } from '../builtins/games/trek.js';
import { qrCommand } from '../builtins/games/qr.js';
import { asciiquariumCommand, cmatrixCommand, rainCommand, slCommand, snakeCommand, tetrisCommand } from '../builtins/games/show.js';
import { ddateCommand, pomCommand, stardateCommand, sunriseCommand } from '../builtins/games/sky.js';
import { builtin_grep } from '../builtins/sys/grep.js';
import { builtin_cut, builtin_head, builtin_sort, builtin_tail, builtin_uniq, builtin_wc } from '../builtins/sys/textFilters.js';
import { commandCommand } from '../builtins/sys/command.js';
import { killCommand, waitCommand } from '../builtins/sys/tasks.js';
import { fgCommand, jobletsCommand } from '../builtins/sys/joblets.js';
import { setCommand, unsetCommand } from '../builtins/sys/variables.js';
import { echoCommand, printfCommand } from '../builtins/sys/echo.js';
import { expectCommand } from '../builtins/res/expect.js';
import { playCommand } from '../builtins/res/play.js';
import { aproposCommand, manCommand } from '../builtins/sys/apropos.js';
import { revCommand, rot13Command, seqCommand, shufCommand, tacCommand, yesCommand } from '../builtins/games/text.js';
import { wtfCommand } from '../builtins/games/wtf.js';
import { debugCommand } from '../builtins/debug.js';
import { builtin_cat } from '../builtins/fs/cat.js';
import { cdCommand } from '../builtins/fs/cd.js';
import { builtin_cp } from '../builtins/fs/cp.js';
import { lsCommand } from '../builtins/fs/ls.js';
import { builtin_mkdir } from '../builtins/fs/mkdir.js';
import { builtin_mv } from '../builtins/fs/mv.js';
import { pwdCommand } from '../builtins/fs/pwd.js';
import { builtin_url } from '../builtins/fs/url.js';
import { builtin_rm } from '../builtins/fs/rm.js';
import { builtin_rmdir } from '../builtins/fs/rmdir.js';
import { builtin_touch } from '../builtins/fs/touch.js';
import { builtin_find } from '../builtins/fs/find.js';
import { helpCommand } from '../builtins/help.js';
import { calCommand } from '../builtins/sys/cal.js';
import { dateCommand } from '../builtins/sys/date.js';
import { fortuneCommand } from '../builtins/sys/fortune.js';
import { timingCommand } from '../builtins/sys/timing.js';
import { versionCommand } from '../builtins/sys/version.js';
import { weatherCommand } from '../builtins/sys/weather.js';
import { notesCommand } from '../builtins/sys/notes.js';
import { envelopeHandler_wrap } from './sink.js';

const envelope: Record<string, EnvelopeHandler> = {
  cat: builtin_cat,
  find: builtin_find,
  cp: builtin_cp,
  mv: builtin_mv,
  rm: builtin_rm,
  mkdir: builtin_mkdir,
  rmdir: builtin_rmdir,
  touch: builtin_touch,
  url: builtin_url,
  grep: builtin_grep,
  wc: builtin_wc,
  head: builtin_head,
  tail: builtin_tail,
  sort: builtin_sort,
  uniq: builtin_uniq,
  cut: builtin_cut,
};

const plain: Record<string, CommandHandler> = {
  url:envelopeHandler_wrap((args: string[]) => builtin_url(args)),
  cat: envelopeHandler_wrap(builtin_cat),
  find: envelopeHandler_wrap(builtin_find),
  rm: envelopeHandler_wrap(builtin_rm),
  cp: envelopeHandler_wrap(builtin_cp),
  mv: envelopeHandler_wrap(builtin_mv),
  touch: envelopeHandler_wrap(builtin_touch),
  mkdir: envelopeHandler_wrap(builtin_mkdir),
  rmdir: envelopeHandler_wrap(builtin_rmdir),
  grep: envelopeHandler_wrap(builtin_grep),
  wc: envelopeHandler_wrap(builtin_wc),
  head: envelopeHandler_wrap(builtin_head),
  tail: envelopeHandler_wrap(builtin_tail),
  sort: envelopeHandler_wrap(builtin_sort),
  uniq: envelopeHandler_wrap(builtin_uniq),
  cut: envelopeHandler_wrap(builtin_cut),
};


/** The core commands: their handlers. Their help is registered from `builtins/help.ts`, which holds it. */
/**
 * What the core's commands hold of the session: a read holds nothing and
 * runs beside anything. A command not named holds the whole session (a
 * game, a play, anything that asks); a declared command says in its
 * declaration (`cd` holds the working directory).
 */
const holds: Record<string, readonly SessionPiece[]> = {
  ...Object.fromEntries([
    'cat', 'cut', 'find', 'grep', 'head', 'sort', 'tail', 'uniq', 'wc',
  ].map((name: string): [string, readonly SessionPiece[]] => [name, []])),
};

/** The core commands declared in one record each: grammar, kinds, handler, holds and help together. */
const declarations: ReadonlyArray<AnyCommandDeclaration> = [
  lsCommand, cdCommand, pwdCommand, timingCommand, debugCommand,
  // General, in the order their handlers listed before they were declared.
  commandCommand, aproposCommand, manCommand, killCommand, waitCommand, fgCommand, jobletsCommand,
  setCommand, echoCommand, printfCommand, unsetCommand, versionCommand, notesCommand, dateCommand, helpCommand,
  // The games shelf and the workflows, in the order their handlers listed before they were declared.
  fortuneCommand, cowsayCommand, cowthinkCommand, figletCommand, bannerCommand, lolcatCommand, revCommand, tacCommand,
  yesCommand, seqCommand, factorCommand, primesCommand, shufCommand, rollCommand, rot13Command, morseCommand,
  calcCommand, unitsCommand, whoCommand, uptimeCommand, sayCommand, wtfCommand, qrCommand, pomCommand,
  stardateCommand, ddateCommand, sunriseCommand, timerCommand, expectCommand, playCommand, leaveCommand, stopwatchCommand,
  slCommand, cmatrixCommand, rainCommand, asciiquariumCommand, tetrisCommand, snakeCommand, quizCommand, hangmanCommand,
  trekCommand, game2048Command, weatherCommand, calCommand,
];

export const coreCommands: CommandGroup = {
  envelope,
  plain,
  holds,
  declarations,
};
