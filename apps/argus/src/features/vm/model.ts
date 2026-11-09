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
import { BERTH_LIMITS_DEFAULT, berthCapacity_derive, profileFloor_get, type BerthLimits, type ChrisProfileFloor, type HostSize, type ChrisBerthModel, type ChrisProfileOffer, type VmStatusRow } from '@fnndsc/menu';
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

/** One OpenSSH public key line, as the engine takes it (`vm new --ssh-key`). */
const SSH_KEY_LINE: RegExp = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]{16,}( [^\n]*)?$/;

/** A Linux user's name public SSH may admit: not root, not the image's own. */
const SSH_USER_WORD: RegExp = /^[a-z_][a-z0-9_-]{0,31}$/;

/** A service being added, as typed. */
export interface ServiceDraft {
  readonly kind: 'WEB' | 'CUSTOM' | 'SSH';
  readonly port: string;
  readonly user: string;
  readonly key: string;
}

/**
 * Why a service as typed cannot be added, or null when it can: the screen
 * says it on ADD before the press, so nothing the engine would refuse is
 * ever written on the line.
 *
 * @param draft - The service as typed.
 * @param open - The ports the line opens already.
 * @param sshPort - Public SSH's port when declared, or null.
 * @returns The reason in a few words, or null.
 *
 * @example
 * ```ts
 * serviceDraft_why({ kind: 'CUSTOM', port: '22', user: 'ops', key: '' }, [80, 443], null); // '22 IS SSH: ADD PUBLIC SSH'
 * ```
 */
export function serviceDraft_why(draft: ServiceDraft, open: ReadonlyArray<number>, sshPort: number | null): string | null {
  const port: number = Number(draft.port);
  if (draft.port === '') return 'A PORT';
  if (!/^[0-9]+$/.test(draft.port) || port < 1 || port > 65535) return 'A PORT IS 1–65535';
  if (open.includes(port) || port === sshPort) return `${port} IS OPEN ALREADY`;
  if (draft.kind === 'WEB' && port !== 80 && port !== 443) return 'WEB IS 80 OR 443';
  if (draft.kind !== 'SSH' && port === 22) return '22 IS SSH: ADD PUBLIC SSH';
  if (draft.kind === 'SSH') {
    const user: string = draft.user === '' ? 'ops' : draft.user;
    if (!SSH_USER_WORD.test(user) || user === 'root' || user === 'ubuntu') return 'A LINUX USER, NOT ROOT OR UBUNTU';
    if (draft.key === '') return 'ITS PUBLIC KEY';
    if (/PRIVATE KEY/.test(draft.key)) return 'THAT IS A PRIVATE KEY';
    const file: boolean = draft.key.startsWith('/') || draft.key.startsWith('~/');
    if (!file && !SSH_KEY_LINE.test(draft.key)) return 'NOT A PUBLIC KEY (ssh-ed25519 …) OR A .pub PATH';
  }
  return null;
}

/**
 * The floor a size lever has on a machine that stands: a boot disk and a
 * data volume only grow, so what runs is the least either can be offered.
 *
 * @param word - The lever (`--disk`, `--data`; others have none).
 * @param least - The shape's own least.
 * @param runs - What runs of it, or null when nothing was read.
 * @returns The least to offer.
 *
 * @example
 * ```ts
 * leverFloor_derive('--disk', 50, 150); // 150
 * ```
 */
export function leverFloor_derive(word: string, least: number, runs: number | null): number {
  return (word === '--disk' || word === '--data') && runs !== null ? Math.max(least, runs) : least;
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

/** A ChRIS profile as PROFILE's listing shows it: what it puts up, what it needs, its state, and why it is not offered (null when it is). */
export interface ProfileRow {
  readonly name: string;
  readonly puts: string;
  readonly needs: string;
  readonly state: string;
  readonly chosen: boolean;
  readonly why: string | null;
}

/**
 * The listing's rows: every profile stratus knows, each offered only when it
 * is built and the machine standing is big enough for it
 * (a-control-offers-only-what-can-be-done).
 *
 * @param offers - The profiles, as the menu lists them.
 * @param stands - What the machine has, or null when none stands.
 * @param chosen - The profile the line declares.
 * @returns A row a profile.
 */
export function profileRows_derive(offers: ReadonlyArray<ChrisProfileOffer>, stands: VmStatusRow['stands'] | null, chosen: string): ProfileRow[] {
  return offers.map((offer: ChrisProfileOffer): ProfileRow => {
    const floor: ChrisProfileFloor | null = offer.floor;
    const below: string[] = [];
    if (floor !== null && stands != null) {
      if (stands.vcpu !== null && stands.vcpu < floor.vcpu) below.push(`${stands.vcpu} of ${floor.vcpu} vCPU`);
      if (stands.memory !== null && stands.memory < floor.memory) below.push(`${stands.memory} of ${floor.memory} GiB`);
      if (stands.data !== null && stands.data < floor.data) below.push(`data ${stands.data} of ${floor.data} GB`);
    }
    const why: string | null = !offer.built ? 'not built yet' : below.length > 0 ? `the machine has ${below.join(', ')}` : null;
    const isChosen: boolean = offer.name === chosen;
    const state: string = why !== null ? (offer.built ? `too small: ${below.join(', ')}` : 'not built yet') : isChosen ? 'available · chosen' : 'available';
    const needs: string = floor === null ? 'floor to be set' : `${floor.vcpu} vCPU · ${floor.memory} GiB · data ${floor.data} GB`;
    return { name: offer.name, puts: offer.summary, needs, state, chosen: isChosen, why };
  });
}

/** An account as CUBE holds it, read live: its CUBE id (null when CUBE does not say) and its groups. */
export interface HeldAccount {
  readonly username: string;
  readonly email: string;
  readonly id: number | null;
  readonly groups: ReadonlyArray<string>;
}

/** What the operator changed of a held account, not yet applied: its email, its groups (whole). A password is set in its row, never batched. */
export interface AccountEdit {
  readonly email?: string;
  readonly groups?: ReadonlyArray<string>;
}

/** A new account the operator wrote, not yet applied: a row of its own until APPLY makes it. */
export interface AccountDraft {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly groups: ReadonlyArray<string>;
}

/** One change to a ChRIS's accounts: what it does in words, the line that does it, why it cannot (null when it can). */
export interface AccountChange {
  readonly account: string;
  readonly words: string;
  readonly line: string;
  readonly why: string | null;
  /** A new account's `chris user add` line, which APPLY writes into the script before it runs. */
  readonly declares: boolean;
}

/** The group every CUBE account is in: always on, never a choice. */
export const ALL_USERS_GROUP: string = 'all_users';

/** The admin CUBE makes, whose new password restarts CUBE. */
export const CHRIS_ADMIN_NAME: string = 'chris';

/** A user name CUBE takes, as stratus checks it: four to thirty-two of Django's letters. */
const ACCOUNT_NAME: RegExp = /^[A-Za-z0-9_.@+-]{4,32}$/;

/** An email address, as stratus checks it. */
const ACCOUNT_EMAIL: RegExp = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * The groups beside `all_users`, as a `--groups` value names them.
 *
 * @param groups - The whole set.
 * @returns The value, or empty when only `all_users`.
 */
function groupsWord_derive(groups: ReadonlyArray<string>): string {
  return [...new Set(groups)].filter((name: string): boolean => name !== ALL_USERS_GROUP).sort().join(',');
}

/**
 * A groups change in words: what joins and what leaves.
 *
 * @param had - The groups held.
 * @param wanted - The groups asked.
 * @returns `+ a, − b`, or empty when nothing moves.
 */
export function groupsMove_words(had: ReadonlyArray<string>, wanted: ReadonlyArray<string>): string {
  const plus: string[] = wanted.filter((name: string): boolean => !had.includes(name)).sort();
  const minus: string[] = had.filter((name: string): boolean => !wanted.includes(name)).sort();
  return [...plus.map((name: string): string => `+ ${name}`), ...minus.map((name: string): string => `− ${name}`)].join(', ');
}

/**
 * Every pending change to a ChRIS's accounts, in the order APPLY runs them:
 * new accounts, then changes of email and groups (a password is set in its
 * row, never here). Each says why it cannot be done when the screen can
 * know (a name or an email CUBE would refuse); such a change is listed and
 * left out of APPLY (a-control-offers-only-what-can-be-done).
 *
 * @param held - The accounts CUBE holds.
 * @param edits - The changes of held accounts, by name.
 * @param drafts - The new accounts.
 * @param on - The machine the ChRIS runs on.
 * @returns The changes.
 */
export function accountChanges_derive(held: ReadonlyArray<HeldAccount>, edits: ReadonlyMap<string, AccountEdit>, drafts: ReadonlyArray<AccountDraft>, on: string): AccountChange[] {
  const adds: AccountChange[] = [];
  const mods: AccountChange[] = [];
  const names: Set<string> = new Set(held.map((one: HeldAccount): string => one.username));
  const emailOwner = (email: string, self: string): string | undefined => held.find((one: HeldAccount): boolean => one.email === email && one.username !== self)?.username;
  const drafted: Map<string, number> = new Map();
  for (const draft of drafts) drafted.set(draft.name, (drafted.get(draft.name) ?? 0) + 1);
  for (const draft of drafts) {
    const groups: string = groupsWord_derive(draft.groups);
    const why: string | null = draft.name === '' ? 'a name' : !ACCOUNT_NAME.test(draft.name) ? 'a name is 4 to 32 letters, digits or . @ + - _'
      : names.has(draft.name) ? `${draft.name} is an account already` : (drafted.get(draft.name) ?? 0) > 1 ? `${draft.name} is written twice`
        : draft.email === '' ? 'an email' : !ACCOUNT_EMAIL.test(draft.email) ? `${draft.email} is not an email address`
          : emailOwner(draft.email, draft.name) !== undefined ? `${draft.email} is ${emailOwner(draft.email, draft.name) ?? ''}'s already` : null;
    adds.push({
      account: draft.name, declares: true, why,
      words: `add user ${draft.name || '(no name yet)'} · groups ${[ALL_USERS_GROUP, ...groups.split(',').filter((one: string): boolean => one !== '')].join(', ')}`,
      line: `chris user add ${draft.name || '<name>'} --email ${draft.email || '<email>'}${groups !== '' ? ` --groups ${groups}` : ''} --on ${on}`,
    });
  }
  for (const account of held) {
    const edit: AccountEdit | undefined = edits.get(account.username);
    if (edit === undefined) continue;
    const said: string[] = [];
    const options: string[] = [];
    let why: string | null = null;
    if (edit.email !== undefined && edit.email !== account.email) {
      said.push(`email ${account.email || '(none)'} → ${edit.email}`);
      options.push(`--email ${edit.email}`);
      why = !ACCOUNT_EMAIL.test(edit.email) ? `${edit.email} is not an email address` : emailOwner(edit.email, account.username) !== undefined ? `${edit.email} is ${emailOwner(edit.email, account.username) ?? ''}'s already` : null;
    }
    if (edit.groups !== undefined) {
      const moved: string = groupsMove_words(account.groups, [...new Set([ALL_USERS_GROUP, ...edit.groups])]);
      if (moved !== '') {
        said.push(`groups ${moved}`);
        options.push(`--groups ${groupsWord_derive(edit.groups) || ALL_USERS_GROUP}`);
      }
    }
    if (said.length > 0) mods.push({ account: account.username, declares: false, why, words: `${said.map((one: string, at: number): string => (at === 0 ? `${one.split(' ')[0] ?? ''} for ${account.username}: ${one.split(' ').slice(1).join(' ')}` : one)).join(' · ')}`, line: `chris user mod ${account.username} ${options.join(' ')} --on ${on}` });
  }
  return [...adds, ...mods];
}

/** A row of ITS USERS: a held account (its pending change in place), a script line's account CUBE does not hold yet, or a new one written here. */
export interface AccountRow {
  readonly key: string;
  readonly kind: 'held' | 'lined' | 'new';
  readonly name: string;
  readonly uid: string;
  readonly gid: string;
  readonly groups: string;
  readonly email: string;
  readonly password: string;
  /** HOST ACCESS: the person's berth as porter read it (`running · 3% · 210 MiB / 2 GiB`, `stopped · home kept`, `none`), or `—` when it was not read. */
  readonly access: string;
  readonly pending: boolean;
}

/**
 * A byte count in the largest binary unit that keeps it short: whole MiB
 * under a GiB, GiB with a decimal only when it is not whole.
 *
 * @param bytes - The count.
 * @returns `210 MiB`, `2 GiB`, `1.5 GiB`.
 */
export function bytes_words(bytes: number): string {
  const gib: number = bytes / 1024 ** 3;
  const mib: number = Math.round(bytes / 1024 ** 2);
  // Whole MiB reaching a GiB is shown in GiB: 1023.5 MiB rounds to 1024 MiB, which is 1 GiB.
  if (mib < 1024) return `${mib} MiB`;
  const tenths: number = Math.round(gib * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} GiB`;
}

/**
 * HOST ACCESS for one person (a-control-offers-only-what-can-be-done: it
 * shows what stands and offers nothing): a running berth with what it uses,
 * a stopped one as the home kept, `none` for a person with neither; `—` when
 * porter's berths were not read at all.
 *
 * @param berths - The berths porter answered, or null when they were not read.
 * @param user - The CUBE user.
 * @returns The cell's words.
 */
export function access_words(berths: ReadonlyArray<ChrisBerthModel> | null, user: string): string {
  if (berths === null) return '—';
  const berth: ChrisBerthModel | undefined = berths.find((one: ChrisBerthModel): boolean => one.user === user);
  if (berth === undefined) return 'none';
  if (berth.state === 'stopped') return 'stopped · home kept';
  const cpu: string | null = berth.cpuPercent === null ? null : berth.cpuPercent > 0 && berth.cpuPercent < 1 ? '<1%' : `${Math.round(berth.cpuPercent)}%`;
  const memory: string | null = berth.memoryBytes === null ? null : berth.memoryLimitBytes === null ? bytes_words(berth.memoryBytes) : `${bytes_words(berth.memoryBytes)} / ${bytes_words(berth.memoryLimitBytes)}`;
  return ['running', cpu, memory].filter((one: string | null): one is string => one !== null).join(' · ');
}

/** A deploy setting as CHRIS's settings listing shows it: the field, what the line sets it to, what runs, and whether a replay changes it. */
export interface SettingRow {
  readonly word: string;
  readonly field: string;
  readonly setTo: string;
  readonly runs: string;
  /** Whether the line sets it to something other than what runs: a replay changes it. */
  readonly edited: boolean;
  /** The line's own value, empty when it sets none. */
  readonly value: string;
  readonly placeholder: string;
}

/** A host name as the engine takes one for `--host` and `--porter`. */
const SETTING_HOST: RegExp = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A compute resource's name, as the deploy registers it. */
const SETTING_COMPUTE: RegExp = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** What the deploy that runs was given, for the settings' RUNS column; berths and their limits are null when not read (an older daemon). */
export interface SettingRuns {
  readonly compute: string;
  readonly host: string | null;
  readonly porter: string | null;
  /** Whether berths run behind porter. */
  readonly berths: boolean | null;
  /** What one berth may use as the deploy wrote it; null on a record from before limits, whose launcher ran the defaults. */
  readonly berthLimits: BerthLimits | null;
}

/** A berth's CPUs on the line: a positive number, at most two decimals. */
const SETTING_BERTH_CPUS: RegExp = /^\d+(\.\d{1,2})?$/;

/** A berth's memory in GiB on the line: a positive number, at most one decimal. */
const SETTING_BERTH_MEMORY: RegExp = /^\d+(\.\d)?$/;

/** A number as the engine reads it, so `2.0` and `2` are one value; the word itself when it is no number. */
function number_word(word: string): string {
  const value: number = Number(word);
  return word !== '' && Number.isFinite(value) ? String(value) : word;
}

/**
 * Whether the line puts berths behind porter, as the engine reads it: a
 * porter and not `--berths off`.
 *
 * @param text - The `chris deploy` line.
 * @returns True when berths are on.
 */
export function lineBerths_read(text: string): boolean {
  const options: ReadonlyArray<readonly [string, string]> = line_parse(text).options;
  const get = (word: string): string => options.find(([each]): boolean => each === word)?.[1] ?? '';
  return get('--porter') !== '' && get('--berths') !== 'off';
}

/**
 * What one berth may use on the line.
 *
 * @param text - The `chris deploy` line.
 * @returns The limits (the defaults for an option the line lacks), or null when the line names one the engine would refuse.
 */
export function lineBerthLimits_read(text: string): BerthLimits | null {
  const options: ReadonlyArray<readonly [string, string]> = line_parse(text).options;
  const get = (word: string): string => options.find(([each]): boolean => each === word)?.[1] ?? '';
  const cpus: string = get('--berth-cpus');
  const memory: string = get('--berth-memory');
  if ((cpus !== '' && !(SETTING_BERTH_CPUS.test(cpus) && Number(cpus) > 0)) || (memory !== '' && !(SETTING_BERTH_MEMORY.test(memory) && Number(memory) > 0))) return null;
  return { cpus: cpus === '' ? BERTH_LIMITS_DEFAULT.cpus : Number(cpus), memoryGib: memory === '' ? BERTH_LIMITS_DEFAULT.memoryGib : Number(memory) };
}

/**
 * The deploy's settings, a row each: COMPUTE, HOST, PORTER, BERTHS, BERTH
 * CPU and BERTH MEMORY, each with what the line sets and what runs (none
 * read: a dash). Berth limits are set only where berths are on; elsewhere
 * the line sets none, and the row says so.
 *
 * @param text - The `chris deploy` line.
 * @param vm - The machine (COMPUTE's default).
 * @param runs - What the deploy that runs was given, or null when none runs.
 * @returns The rows.
 */
export function settingRows_derive(text: string, vm: string, runs: SettingRuns | null): SettingRow[] {
  const get = (word: string): string => line_parse(text).options.find(([each]): boolean => each === word)?.[1] ?? '';
  const row = (word: string, field: string, value: string, shown: string, ran: string | null, placeholder: string, changes: boolean = true): SettingRow =>
    ({ word, field, value, placeholder, setTo: shown, runs: ran ?? '—', edited: changes && ran !== null && shown !== ran });
  const compute: string = get('--compute');
  const host: string = get('--host');
  const porter: string = get('--porter');
  const berths: string = get('--berths');
  const cpus: string = get('--berth-cpus');
  const memory: string = get('--berth-memory');
  const on: boolean = lineBerths_read(text);
  const ranBerths: boolean | null = runs === null ? null : runs.berths;
  const ranLimits: BerthLimits | null = ranBerths === true ? (runs?.berthLimits ?? BERTH_LIMITS_DEFAULT) : null;
  return [
    row('--compute', 'COMPUTE', compute, compute || vm, runs === null ? null : runs.compute, `the pfcon resource's name (empty: ${vm})`),
    row('--host', 'HOST', host, host || 'by address', runs === null ? null : runs.host ?? 'by address', 'cube.example.org (empty: by address)'),
    row('--porter', 'PORTER', porter, porter || 'none', runs === null ? null : runs.porter ?? 'none', 'porter.example.org (empty: none)'),
    row('--berths', 'BERTHS', berths, berths || (porter !== '' ? 'on' : 'off'), ranBerths === null ? null : ranBerths ? 'on' : 'off', 'on or off (empty: on with a porter)'),
    row('--berth-cpus', 'BERTH CPU', cpus, on ? number_word(cpus) || String(BERTH_LIMITS_DEFAULT.cpus) : '—', ranLimits === null ? null : String(ranLimits.cpus), `CPUs one berth may use (empty: ${BERTH_LIMITS_DEFAULT.cpus})`, on),
    row('--berth-memory', 'BERTH MEMORY', memory, on ? `${number_word(memory) || String(BERTH_LIMITS_DEFAULT.memoryGib)} GiB` : '—', ranLimits === null ? null : `${ranLimits.memoryGib} GiB`, `GiB one berth may use (empty: ${BERTH_LIMITS_DEFAULT.memoryGib})`, on),
  ];
}

/**
 * How many berths a machine holds, as the band says it.
 *
 * Berths and their limits are what run when a deploy stands, else the line's.
 * Nothing is said when berths are off or the machine's size is unknown.
 *
 * @param host - The machine's vCPUs and GiB of memory, or null when its shape is not known.
 * @param text - The `chris deploy` line, or null when the script has none.
 * @param runs - What the deploy that runs was given, or null when none runs.
 * @param profile - The ChRIS profile, whose floor CUBE takes before any berth.
 * @param change - Whether to add the count at the line's limits when they differ from what runs.
 * @returns `holds 3 berths`, with `· 2 after the change` when asked and the line's limits differ; or null.
 *
 * @example
 * ```ts
 * berthsHold_words({ vcpu: 4, memory: 8 }, 'chris deploy store --profile minimal --porter p.example.org', null, 'minimal'); // 'holds 2 berths'
 * berthsHold_words({ vcpu: 4, memory: 8 }, 'chris deploy store --profile minimal --porter p.example.org --berth-cpus 2', { compute: 'store', host: 'h.example.org', porter: 'p.example.org', berths: true, berthLimits: null }, 'minimal', true); // 'holds 2 berths · 1 after the change'
 * ```
 */
export function berthsHold_words(host: { readonly vcpu: number | null; readonly memory: number | null } | null, text: string | null, runs: SettingRuns | null, profile: string, change: boolean = false): string | null {
  if (host === null || host.vcpu === null || host.memory === null) return null;
  let limits: BerthLimits | null;
  if (runs !== null && runs.berths !== null) limits = runs.berths ? (runs.berthLimits ?? BERTH_LIMITS_DEFAULT) : null;
  else limits = text !== null && lineBerths_read(text) ? lineBerthLimits_read(text) : null;
  if (limits === null) return null;
  const size: HostSize = { cpus: host.vcpu, memoryGib: host.memory };
  const held: number = berthCapacity_derive(size, profileFloor_get(profile), { limits, holds: null });
  const words: string = `holds ${held} berth${held === 1 ? '' : 's'}`;
  if (!change || runs === null || runs.berths !== true || text === null || !lineBerths_read(text)) return words;
  const asked: BerthLimits | null = lineBerthLimits_read(text);
  if (asked === null || (asked.cpus === limits.cpus && asked.memoryGib === limits.memoryGib)) return words;
  return `${words} · ${berthCapacity_derive(size, profileFloor_get(profile), { limits: asked, holds: null })} after the change`;
}

/**
 * Why berths of the limits named cannot be held, as `chris deploy` refuses them: a berth's CPUs above the machine's, or no berth's memory left above the profile's floor.
 *
 * @param shape - The machine's vCPUs and GiB of memory, or null when its shape is not known.
 * @param cpus - A berth's CPUs as the line has them (empty: the default).
 * @param memory - A berth's GiB as the line has them (empty: the default).
 * @param profile - The profile as the line names it (empty: the minimal profile).
 * @returns Why not, or null when one fits or the shape is not known.
 */
function limitsFit_why(shape: { readonly vcpu: number | null; readonly memory: number | null } | null, cpus: string, memory: string, profile: string): string | null {
  if (shape === null || shape.vcpu === null || shape.memory === null) return null;
  const limits: BerthLimits = { cpus: cpus === '' ? BERTH_LIMITS_DEFAULT.cpus : Number(cpus), memoryGib: memory === '' ? BERTH_LIMITS_DEFAULT.memoryGib : Number(memory) };
  if (!(limits.cpus > 0) || !(limits.memoryGib > 0)) return null;
  if (limits.cpus > shape.vcpu) return `--berth-cpus ${limits.cpus}: this machine has ${shape.vcpu} vCPU`;
  const floor: ChrisProfileFloor = profileFloor_get(profile === '' ? 'minimal' : profile);
  if (berthCapacity_derive({ cpus: shape.vcpu, memoryGib: shape.memory }, floor, { limits, holds: null }) > 0) return null;
  return `berths of ${limits.memoryGib} GiB do not fit this machine above the ${profile === '' ? 'minimal' : profile} profile's floor (${shape.memory} GiB; the floor takes ${floor.memory} GiB)`;
}

/**
 * Why a setting cannot take a value, as the engine would refuse it; null when it can.
 *
 * @param word - The option.
 * @param value - The value typed (empty: the option taken away).
 * @param text - The line, for what the other settings hold.
 * @param shape - The machine's vCPUs and GiB of memory, or null when its shape is not known.
 * @returns Why not, or null.
 */
export function settingValue_why(word: string, value: string, text: string, shape: { readonly vcpu: number | null; readonly memory: number | null } | null = null): string | null {
  const options: ReadonlyArray<readonly [string, string]> = line_parse(text).options;
  const get = (each: string): string => options.find(([one]): boolean => one === each)?.[1] ?? '';
  if (value === '') {
    if (word === '--host' && get('--porter') !== '') return 'porter needs a host: clear PORTER first';
    if (word === '--porter' && (get('--berths') === 'on' || get('--berth-cpus') !== '' || get('--berth-memory') !== '')) return 'berths need a porter: clear BERTHS, BERTH CPU and BERTH MEMORY first';
    return null;
  }
  if (word === '--compute') return SETTING_COMPUTE.test(value) ? null : 'a name of letters, digits, . _ -';
  if (word === '--berths') {
    if (value !== 'on' && value !== 'off') return 'on or off';
    if (value === 'off' && (get('--berth-cpus') !== '' || get('--berth-memory') !== '')) return 'clear BERTH CPU and BERTH MEMORY first';
    return value === 'on' && get('--porter') === '' ? 'berths need a PORTER first' : null;
  }
  if (word === '--berth-cpus' || word === '--berth-memory') {
    const cpus: boolean = word === '--berth-cpus';
    if (!(cpus ? SETTING_BERTH_CPUS : SETTING_BERTH_MEMORY).test(value) || !(Number(value) > 0)) return cpus ? 'a positive number of CPUs, at most two decimals' : 'a positive number of GiB, at most one decimal';
    if (get('--porter') === '') return 'berths need a PORTER first';
    if (get('--berths') === 'off') return 'berths are off: set BERTHS on, or leave this empty';
    return limitsFit_why(shape, cpus ? value : get('--berth-cpus'), cpus ? get('--berth-memory') : value, get('--profile'));
  }
  if (!SETTING_HOST.test(value)) return 'a host name, as cube.example.org';
  if (word === '--porter') {
    const host: string = get('--host');
    if (host === '') return 'porter needs a HOST first';
    if (host === value) return 'porter needs a name of its own, not CUBE\'s';
  }
  return null;
}

/** The least and most a CUBE password is, as the engine takes one. */
export const PASSWORD_MIN: number = 8;
export const PASSWORD_MAX: number = 100;

/**
 * Why a new password typed twice cannot be set yet; null when it can.
 *
 * @param typed - The new password.
 * @param again - Typed again.
 * @returns What it still needs, or null.
 */
export function passwordPair_why(typed: string, again: string): string | null {
  if (typed === '') return 'a new password, or GENERATE';
  if (typed.length < PASSWORD_MIN) return `at least ${PASSWORD_MIN} characters`;
  if (typed.length > PASSWORD_MAX) return `at most ${PASSWORD_MAX} characters`;
  if (again === '') return 'typed again';
  return typed === again ? null : 'the two differ';
}
