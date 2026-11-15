/**
 * @file Every command is declared in one record, and help lists it: each
 * name the engine answers has a declaration (a command's, or an alias of
 * one), each page a shell word's or a declaration's, and each declares a
 * category `help` knows, or stands on the games shelf (its own page). A
 * command added without one fails here, so it cannot go missing from `help`
 * (#1102), nor answer a name with no declaration behind it (#222).
 *
 * Read from brasa's build output in a plain Node process, as every
 * consumer meets the registry (the package entry registers the core's and
 * the ChRIS backend's commands). CI builds before it tests; locally the
 * test skips when brasa is unbuilt.
 */
import { beforeAll, describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const dist: string = join(process.cwd(), 'dist');
const built: boolean = existsSync(join(dist, 'core', 'dispatch.js'));
if (!built && process.env['CI'] !== undefined) throw new Error('helpCategories: brasa is not built; CI must build before testing');

/** What the registry holds, as the script reads it. */
interface RegistryReading {
  /** Names answered by a handler with no declaration behind them. */
  undeclared: string[];
  /** Each page by name: its category and whether it mirrors a Unix utility. */
  pages: Record<string, { category?: string; posix: boolean; shellWord: boolean }>;
  /** The categories `help` lists. */
  categories: string[];
  /** The games shelf's commands. */
  shelf: string[];
}

/** The script: the registry, read after the package entry registered every command. */
const SCRIPT: string = `
const dist = ${JSON.stringify(dist)};
await import(dist + '/index.js');
const registry = await import(dist + '/core/commandRegistry.js');
const help = await import(dist + '/builtins/help.js');
const shelf = await import(dist + '/builtins/games/shelf.js');
const { SHELL_WORDS } = await import(dist + '/core/shellWords.js');
const names = [...new Set([...registry.envelopeCommand_names(), ...registry.plainCommand_names()])];
const words = new Set(SHELL_WORDS.map((word) => word.name));
const pages = {};
for (const name of registry.helpTopic_names()) {
  const declared = registry.commandDeclaration_get(name);
  const entry = registry.commandHelpEntry_get(name);
  pages[name] = { category: entry?.category, posix: (declared?.help.posix ?? entry?.posix) !== undefined, shellWord: words.has(name) && declared === undefined };
}
const reading = {
  undeclared: names.filter((name) => registry.commandDeclaration_get(name) === undefined),
  pages,
  categories: [...help.HELP_CATEGORIES],
  shelf: shelf.GAMES_SHELF.flatMap((category) => [...category.commands]),
};
process.stdout.write(JSON.stringify(reading), () => process.exit(0));
`;

/**
 * Every TypeScript source under a folder, builds left out.
 *
 * @param folder - The folder.
 * @returns The files.
 */
function sources_list(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry): string[] => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path: string = join(folder, entry.name);
    return entry.isDirectory() ? sources_list(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The packages that register commands, and the suite that holds each one's registry to its declarations. */
const REGISTRY_SUITES: Readonly<Record<string, string>> = {
  'packages/brasa': 'packages/brasa/tests/helpCategories.test.ts',
  'packages/stratus': 'packages/stratus/tests/declarations.test.ts',
};

describe('every module that registers commands', () => {
  it('is in a package whose suite holds every name it registers to a declaration', () => {
    const repo: string = join(process.cwd(), '..', '..');
    const roots: string[] = ['packages', 'apps'].flatMap((parent: string): string[] => {
      const at: string = join(repo, parent);
      return existsSync(at) ? readdirSync(at).map((name: string): string => join(at, name, 'src')).filter((src: string): boolean => existsSync(src)) : [];
    });
    const registering: Set<string> = new Set();
    for (const path of roots.flatMap(sources_list)) {
      // Comments name commands_register in examples; only code counts.
      const code: string = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/commands_register\(/.test(code)) registering.add(relative(repo, path).split('/').slice(0, 2).join('/'));
    }
    expect([...registering].sort()).toEqual(Object.keys(REGISTRY_SUITES).sort());
    for (const suite of Object.values(REGISTRY_SUITES)) expect(existsSync(join(repo, suite))).toBe(true);
  });
});

(built ? describe : describe.skip)('every command, declared and in help [built dist]', () => {
  let reading: RegistryReading;
  beforeAll(() => {
    const home: string = mkdtempSync(join(tmpdir(), 'brasa-help-'));
    try {
      const out: string = execFileSync('node', ['--input-type=module', '-e', SCRIPT], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') },
      });
      reading = JSON.parse(out) as RegistryReading;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it('answers no name without a declaration behind it: one record per command', () => {
    expect(reading.undeclared).toEqual([]);
  });

  it('gives every page a declaration or a shell word\'s record', () => {
    const shellWords: string[] = Object.entries(reading.pages).filter(([, page]) => page.shellWord).map(([name]) => name).sort();
    expect(shellWords).toEqual(['!', 'clear', 'exit', 'prompt', 'sudo']);
  });

  it('every command declares a category help lists, or is on the games shelf', () => {
    const shelf: Set<string> = new Set(reading.shelf);
    const missing: string[] = Object.entries(reading.pages)
      .filter(([name, page]) => !name.includes(' ') && !shelf.has(name) && (page.category === undefined || !reading.categories.includes(page.category)))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('places the commands that went missing from help', () => {
    expect(reading.pages['url']?.category).toBe('Sharing');
    expect(reading.pages['plugin']?.category).toBe('Resources');
    expect(reading.pages['pipelines']?.category).toBe('Resources');
  });

  it('every command named like a Unix utility says how it mirrors it, so help POSIX cannot drift', () => {
    const UNIX: ReadonlyArray<string> = ['ls', 'cd', 'pwd', 'tree', 'du', 'cat', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'chmod', 'setfacl', 'getfacl',
      'setfattr', 'getfattr', 'grep', 'file', 'tac', 'rev', 'seq', 'yes', 'shuf', 'strings', 'xxd', 'md5sum', 'sha256sum', 'date', 'cal', 'uptime', 'who',
      'units', 'factor', 'primes', 'command', 'apropos', 'man', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'env', 'find', 'ln', 'stat'];
    const missing: string[] = UNIX.filter((name) => reading.pages[name] !== undefined && !reading.pages[name]?.posix);
    expect(missing).toEqual([]);
  });
});
