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
export const VM_SEAT_LABELS: Readonly<Partial<Record<StepKind, string>>> = { 'vm new': 'SPEC', 'vm build': 'BUILD', 'chris deploy': 'CHRIS', users: 'USERS' };

/** SERVICES' view key: what the machine opens to the internet, set on its `vm new` line and built with it. */
export const SERVICES_KEY: string = 'services';

/** Public SSH as a `vm new` line declares it. */
export interface VmSshDeclared {
  /** The port it opens. */
  readonly port: number | null;
  /** The administrative Linux user it admits. */
  readonly user: string;
  /** The user's public key on the line, or null when a file is named instead. */
  readonly key: string | null;
  /** The key file the line names, read when the line runs, or null. */
  readonly keyFile: string | null;
  /** Whether the door is open. */
  readonly on: boolean;
}

/** What a `vm new` line opens to the internet. */
export interface VmServicesDeclared {
  /** The ports `--open` opens, sorted. */
  readonly open: number[];
  /** Public SSH, or null when the line declares none. */
  readonly ssh: VmSshDeclared | null;
}

/**
 * What a `vm new` line opens to the internet.
 *
 * @param text - The line.
 * @param kept - Public SSH as the record keeps it, for a line that says only `--ssh off`.
 * @returns The ports and public SSH.
 *
 * @example
 * ```ts
 * vmServices_read('vm new store --open 443,80 --ssh 2222 --ssh-key-file ~/.ssh/id_ed25519.pub', null).ssh?.port; // 2222
 * ```
 */
export function vmServices_read(text: string, kept: { port: number; user: string; key: string; on: boolean } | null): VmServicesDeclared {
  const parts: LineParts = line_parse(text);
  const get = (word: string): string | null => parts.options.find(([each]): boolean => each === word)?.[1] ?? null;
  const openWord: string | null = get('--open');
  const open: number[] = openWord === null || openWord === 'none' ? [] : [...new Set(openWord.split(',').map(Number).filter((port: number): boolean => Number.isInteger(port) && port > 0))].sort((a: number, b: number): number => a - b);
  const sshWord: string | null = get('--ssh');
  if (sshWord === null && kept === null) return { open, ssh: null };
  const on: boolean = sshWord === null ? kept?.on ?? false : sshWord !== 'off';
  const port: number | null = sshWord !== null && sshWord !== 'off' ? Number(sshWord) : kept?.port ?? null;
  return { open, ssh: { port, user: get('--ssh-user') ?? kept?.user ?? 'ops', key: get('--ssh-key') ?? (get('--ssh-key-file') === null ? kept?.key ?? null : null), keyFile: get('--ssh-key-file'), on } };
}

/**
 * A port's kind: the web's two, or a port of the operator's own.
 *
 * @param port - The port.
 * @returns `WEB` or `CUSTOM`.
 */
export function vmServiceKind_derive(port: number): 'WEB' | 'CUSTOM' {
  return port === 80 || port === 443 ? 'WEB' : 'CUSTOM';
}

/**
 * What a line's services would change against what runs: ports opened and
 * closed, public SSH opened, closed, moved, its user or key changed.
 *
 * @param declared - What the line opens.
 * @param runs - The ports the tenancy opens now (public SSH's among them), or null when not read.
 * @param host - What the machine was last set up with, or null.
 * @returns The changes in words; empty when nothing changes.
 *
 * @example
 * ```ts
 * vmServices_change({ open: [80, 443, 8080], ssh: null }, [80, 443], null); // ['open 8080']
 * ```
 */
export function vmServices_change(declared: VmServicesDeclared, runs: ReadonlyArray<number> | null, host: VmStatusRow['host'] | null | undefined): string[] {
  const words: string[] = [];
  const sshNow = host?.ssh ?? null;
  const sshOpenNow: number | null = sshNow !== null && sshNow.on ? sshNow.port : null;
  const others = (ports: ReadonlyArray<number>): number[] => ports.filter((port: number): boolean => port !== sshOpenNow);
  if (runs !== null) {
    const now: number[] = others(runs);
    for (const port of declared.open) if (!now.includes(port)) words.push(`open ${port}`);
    for (const port of now) if (!declared.open.includes(port) && port !== (declared.ssh?.on === true ? declared.ssh.port : null)) words.push(`close ${port}`);
  }
  const want = declared.ssh;
  if (want !== null && want.on && sshOpenNow === null) words.push(`public SSH on ${want.port ?? '?'} for ${want.user}`);
  else if ((want === null || !want.on) && sshOpenNow !== null) words.push(`public SSH on ${sshOpenNow} closed`);
  else if (want !== null && want.on && sshNow !== null) {
    if (want.port !== sshNow.port) words.push(`public SSH ${sshNow.port} → ${want.port ?? '?'}`);
    if (want.user !== sshNow.user) words.push(`public SSH's user ${sshNow.user} → ${want.user}`);
    if (want.key !== null && want.key !== sshNow.key) words.push(`${want.user}'s key replaced`);
  }
  return words;
}

/** The seat that is no line of the script: the undoing, drawn from the VM's own lines (`vm protect`, `vm teardown`). */
export const TEARDOWN_KEY: string = 'teardown';

/** The machines listing's view key: the controller's door, every VM the tenancy runs and + NEW. */
export const MACHINES_KEY: string = 'machines';

/** A machine's facts view key: what it is and what is on it, first when a machine is opened. */
export const FACTS_KEY: string = 'machine';

/**
 * Whether a VM is read and never reached from here: found in the tenancy and
 * not read into this host's cache (made outside stratus, or its stacks not
 * read), or read from the tenancy, which keeps no SSH key for it (built
 * before stratus kept keys there). Only its facts and its teardown stand for it.
 *
 * @param row - The VM as `vm status` reads it.
 * @returns True when its size, build and ChRIS cannot be acted on from here.
 */
export function vmKeyless_is(row: VmStatusRow | null): boolean {
  return row !== null && (row.state === 'found' || row.keyless === true);
}

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
  // A VM found in the tenancy has no spec here: its size is the cloud's, the rest the defaults, to be read and edited.
  const sized: string | null = spec === null && row.found?.vcpus != null && row.found.memoryGib != null
    ? vmNewLine_compose(row.name, 'chrisproject-services').replace(/--vcpu \d+ --memory \d+/, `--vcpu ${row.found.vcpus} --memory ${row.found.memoryGib}`)
    : null;
  const declare: string = sized !== null ? sized : spec === null
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
 * @returns NEW, DECLARED, DATA ONLY, DATA KEPT, BUILT, GONE, FOUND · <the cloud's state>, or RUNNING.
 */
export function vmCondition_derive(row: VmStatusRow | null, busy: boolean): string {
  if (busy) return 'RUNNING';
  if (row === null) return 'NEW';
  // A VM the tenancy runs that this session keeps no record of: what the cloud says it is doing.
  if (row.state === 'found') return `FOUND · ${(row.found?.state ?? 'unknown').toUpperCase()}`;
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
