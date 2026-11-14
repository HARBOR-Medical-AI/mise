/**
 * @file The ChRIS help, registered for a suite as the package entry registers
 * it with the ChRIS commands: a ChRIS builtin's `--help` reads it from the registry.
 *
 * A declared command's help is its declaration's, so the declared commands
 * stand in here too (`declarationStandIns.ts`), as `everyVerb_install` stands
 * in handlers.
 */
import { commands_register } from '../../src/core/commandRegistry.js';
import { chrisHelp } from '../../src/chris/help.js';
import { HELP_ORDER } from '../../src/core/commandOrder.js';
import { berthStandIn_make, downloadStandIn_make, lsStandIn_make } from './declarationStandIns.js';

/** What a stand-in handler answers. */
const ran = async (): Promise<{ status: 'ok'; rendered: string }> => ({ status: 'ok', rendered: '' });

/** Registers the declared commands' stand-ins: the core's, and the ChRIS backend's. */
export function declarations_install(): void {
  commands_register({ declarations: [lsStandIn_make(ran)] });
  commands_register({ declarations: [downloadStandIn_make(ran), berthStandIn_make(ran)] }, 'backend');
}

/** Registers the ChRIS backend's help pages, and the declared commands whose help their declarations hold. */
export function chrisHelp_install(): void {
  commands_register({ help: chrisHelp }, 'backend');
  declarations_install();
}

/**
 * Registers a stand-in handler for every name with help, so a suite sees a
 * session that has every verb (as a ChRIS session does) without loading the
 * commands themselves.
 */
export function everyVerb_install(): void {
  commands_register({ envelope: Object.fromEntries(HELP_ORDER.map((name: string) => [name.split(' ')[0] as string, ran])) });
}
