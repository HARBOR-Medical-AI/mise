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
import { type CommandGroup } from './commandRegistry.js';
import { SHELL_WORDS } from './shellWords.js';
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
import { grepCommand } from '../builtins/sys/grep.js';
import { cutCommand, headCommand, sortCommand, tailCommand, uniqCommand, wcCommand } from '../builtins/sys/textFilters.js';
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
import { catCommand } from '../builtins/fs/cat.js';
import { cdCommand } from '../builtins/fs/cd.js';
import { cpCommand } from '../builtins/fs/cp.js';
import { lsCommand } from '../builtins/fs/ls.js';
import { mkdirCommand } from '../builtins/fs/mkdir.js';
import { mvCommand } from '../builtins/fs/mv.js';
import { pwdCommand } from '../builtins/fs/pwd.js';
import { urlCommand } from '../builtins/fs/url.js';
import { rmCommand } from '../builtins/fs/rm.js';
import { rmdirCommand } from '../builtins/fs/rmdir.js';
import { touchCommand } from '../builtins/fs/touch.js';
import { findCommand } from '../builtins/fs/find.js';
import { helpCommand } from '../builtins/help.js';
import { calCommand } from '../builtins/sys/cal.js';
import { dateCommand } from '../builtins/sys/date.js';
import { fortuneCommand } from '../builtins/sys/fortune.js';
import { timingCommand } from '../builtins/sys/timing.js';
import { versionCommand } from '../builtins/sys/version.js';
import { weatherCommand } from '../builtins/sys/weather.js';
import { notesCommand } from '../builtins/sys/notes.js';

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
  // Files.
  catCommand, findCommand, cpCommand, mvCommand, rmCommand, mkdirCommand, rmdirCommand, touchCommand,
  grepCommand, wcCommand, headCommand, tailCommand, sortCommand, uniqCommand, cutCommand,
  // Sharing.
  urlCommand,
];

/** The core's commands: the shell's own words, and every command declared in one record. */
export const coreCommands: CommandGroup = {
  shellWords: SHELL_WORDS,
  declarations,
};
