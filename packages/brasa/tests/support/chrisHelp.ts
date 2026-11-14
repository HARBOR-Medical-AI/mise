/**
 * @file The ChRIS help, registered for a suite as the package entry registers
 * it with the ChRIS commands: a ChRIS builtin's `--help` reads it from the registry.
 *
 * A declared command's help is its declaration's, so the declared commands
 * stand in here too (`declarationStandIns.ts`), as `everyVerb_install` stands
 * in handlers.
 */
import { builtinCommand_has, commandHelpEntry_get, commands_register, type CommandHelp } from '../../src/core/commandRegistry.js';
import type { AnyCommandDeclaration } from '../../src/core/commandDeclaration.js';
import { HELP_ORDER } from '../../src/core/commandOrder.js';
import {
  berthStandIn_make, CORE_STAND_IN_NAMES, downloadStandIn_make, FILES_STAND_INS, lsStandIn_make, NAVIGATION_STAND_INS, RESOURCE_STAND_INS, SHARING_PACS_IMAGING_STAND_INS, wordsStandIn_make,
} from './declarationStandIns.js';

/** What a stand-in handler answers. */
const ran = async (): Promise<{ status: 'ok'; rendered: string }> => ({ status: 'ok', rendered: '' });

/** Registers the declared commands' stand-ins: the core's, and the ChRIS backend's. */
export function declarations_install(): void {
  const navigation: Array<[string, (typeof NAVIGATION_STAND_INS)[string]]> = Object.entries({ ...NAVIGATION_STAND_INS, ...FILES_STAND_INS });
  const core = navigation.filter(([name]) => CORE_STAND_IN_NAMES.includes(name)).map(([, make]) => make(ran));
  const backend = navigation.filter(([name]) => !CORE_STAND_IN_NAMES.includes(name)).map(([, make]) => make(ran));
  commands_register({ declarations: [lsStandIn_make(ran), ...core] });
  commands_register({ declarations: [downloadStandIn_make(ran), berthStandIn_make(ran), ...backend] }, 'backend');
}

/** Registers the ChRIS backend's commands whose help their declarations hold, standing in. */
export function chrisHelp_install(): void {
  // plugin and pipeline, standing in: their pages are their declarations'.
  commands_register({ declarations: Object.values(RESOURCE_STAND_INS).map((make) => make(ran)) }, 'backend');
  declarations_install();
  // The Sharing, PACS and Imaging commands' pages are their declarations'.
  commands_register({ declarations: Object.values(SHARING_PACS_IMAGING_STAND_INS).map((make) => make(ran)) }, 'backend');
}

/**
 * Registers a stand-in for every name with help that nothing answers yet,
 * so a suite sees a session that has every verb (as a ChRIS session does)
 * without loading the commands themselves. A name with a page keeps it.
 */
export function everyVerb_install(): void {
  const names: string[] = [...new Set(HELP_ORDER.map((name: string): string => name.split(' ')[0] as string))];
  const standIns: AnyCommandDeclaration[] = names.filter((name: string): boolean => !builtinCommand_has(name)).map((name: string): AnyCommandDeclaration => {
    const page: CommandHelp | undefined = commandHelpEntry_get(name);
    const standIn: AnyCommandDeclaration = wordsStandIn_make(name, ran);
    if (page === undefined) return standIn;
    return {
      ...standIn,
      help: {
        usage: page.usage,
        summary: page.summary ?? page.description,
        description: page.description,
        ...(page.category !== undefined ? { category: page.category } : {}),
        ...(page.examples !== undefined ? { examples: page.examples } : {}),
      },
    } as AnyCommandDeclaration;
  });
  commands_register({ declarations: standIns });
}
