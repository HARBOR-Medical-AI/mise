/**
 * @file The VM controller's model (docs/stratus.adoc, D17 revised): a screen
 * keyed by one virtual machine, whose truth underneath is a `.mise` script.
 * Opened on a VM the library or the host already holds, it shows that VM's
 * lines alone; started from nothing it composes them, so what the screen
 * leaves behind is a script under `/scripts/mine/` that replays to where the
 * operator got to. Pure of the DOM and the wire.
 *
 * @module
 */
import type { VmStatusRow } from '@fnndsc/menu';
import { line_parse, type LineParts, type ScriptLine, type StepKind } from '../script/model.js';

/** The seat a VM's line sits on: the controller's words for the script's verbs. */
export const VM_SEAT_LABELS: Readonly<Partial<Record<StepKind, string>>> = { 'vm new': 'SIZE', 'vm build': 'BUILD', 'chris deploy': 'CHRIS', users: 'USERS' };

/** The seat that is no line of the script: the undoing, drawn from the VM's own lines (`vm protect`, `vm teardown`). */
export const TEARDOWN_KEY: string = 'teardown';

/** The seat a machine not yet named starts on. */
export const NEW_KEY: string = 'new';

/** A VM's name, as the kernel takes it: a hostname label of at most 32. */
const VM_NAME: RegExp = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Whether a name is one the kernel would take for a VM.
 *
 * @param name - The name typed.
 * @returns True when `vm new` would take it.
 */
export function vmName_valid(name: string): boolean {
  return VM_NAME.test(name);
}

/**
 * The lines of a script that belong to one VM: its `vm` lines, its `chris
 * deploy`, and the user lines added on it (`--on <name>`, or every user line
 * when the script declares that VM alone).
 *
 * @param lines - The script's lines.
 * @param name - The VM.
 * @returns Its lines, in the script's order.
 */
export function vmLines_filter(lines: ReadonlyArray<ScriptLine>, name: string): ScriptLine[] {
  const declared: string[] = lines.map((line: ScriptLine): LineParts => line_parse(line.text)).filter((parts: LineParts): boolean => parts.verb.join(' ') === 'vm new').map((parts: LineParts): string => parts.subject ?? '');
  const alone: boolean = declared.length === 1 && declared[0] === name;
  return lines.filter((line: ScriptLine): boolean => {
    const parts: LineParts = line_parse(line.text);
    const verb: string = parts.verb.join(' ');
    if (verb.startsWith('vm ')) return parts.subject === name;
    if (verb === 'chris deploy') return parts.subject === name;
    if (verb === 'chris user add') {
      const on: string | undefined = parts.options.find(([word]: [string, string]): boolean => word === '--on')?.[1];
      return on === undefined ? alone : on === name;
    }
    return false;
  });
}

/**
 * The `vm new` line a machine not yet declared starts from: the store's
 * sizes, which the sliders then move.
 *
 * @param name - The VM.
 * @param net - Its network.
 * @returns The line.
 */
export function vmNewLine_compose(name: string, net: string): string {
  return `vm new ${name} --net ${net} --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04`;
}

/**
 * A VM's script from what the host keeps of it, for a VM no script in the
 * library declares (one built by hand, or whose script was not kept): its
 * declaration from its spec, its build, and the ChRIS on it when there is one.
 *
 * @param row - The VM as `vm status` reads it.
 * @returns The script's text.
 */
export function vmScript_synthesize(row: VmStatusRow): string {
  const spec = row.spec;
  const declare: string = spec === null
    ? vmNewLine_compose(row.name, 'chrisproject-services')
    : `vm new ${row.name} --net ${spec.net}${spec.open.length > 0 ? ` --open ${spec.open.join(',')}` : ''} --vcpu ${spec.vcpu} --memory ${spec.memory} --disk ${spec.disk} --data ${spec.data} --data-backup ${spec.dataBackup} --os ${spec.os}`;
  const lines: string[] = [declare, `vm build ${row.name}`];
  if (row.chris !== null) {
    const chris: NonNullable<VmStatusRow['chris']> = row.chris;
    lines.push(`chris deploy ${row.name} --profile ${chris.profile} --compute ${chris.compute}${chris.host !== null ? ` --host ${chris.host}` : ''}${chris.porter !== null ? ` --porter ${chris.porter}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The lines a VM's script must carry for its seats to stand, added where the
 * script lacks them: a `vm build` after its `vm new`.
 *
 * @param text - The script's text.
 * @param name - The VM.
 * @returns The text, with the build line after the declaration when it was missing.
 */
export function vmScript_complete(text: string, name: string): string {
  const lines: string[] = text.split('\n');
  const hasBuild: boolean = lines.some((line: string): boolean => line_parse(line.trim()).verb.join(' ') === 'vm build' && line_parse(line.trim()).subject === name);
  if (hasBuild) return text;
  const at: number = lines.findIndex((line: string): boolean => line_parse(line.trim()).verb.join(' ') === 'vm new' && line_parse(line.trim()).subject === name);
  if (at === -1) return text;
  lines.splice(at + 1, 0, `vm build ${name}`);
  return lines.join('\n');
}

/**
 * The word the controller's CONDITION wears for a VM.
 *
 * @param row - The VM as `vm status` reads it, or null for one not yet declared.
 * @param busy - Whether a line of its own runs now.
 * @returns NEW, DECLARED, DATA ONLY, DATA KEPT, BUILT, GONE, or RUNNING.
 */
export function vmCondition_derive(row: VmStatusRow | null, busy: boolean): string {
  if (busy) return 'RUNNING';
  if (row === null) return 'NEW';
  return row.state.toUpperCase();
}

/**
 * Where a VM's chris deploy line would land in its script: after its build.
 *
 * @param text - The script's text.
 * @param name - The VM.
 * @param line - The line to add.
 * @returns The text with the line after the VM's build (or at the end).
 */
export function vmScript_append(text: string, name: string, line: string): string {
  const lines: string[] = text.replace(/\n$/, '').split('\n');
  const at: number = lines.findIndex((each: string): boolean => line_parse(each.trim()).verb.join(' ') === 'vm build' && line_parse(each.trim()).subject === name);
  if (at === -1) lines.push(line); else lines.splice(at + 1, 0, line);
  return `${lines.join('\n')}\n`;
}
