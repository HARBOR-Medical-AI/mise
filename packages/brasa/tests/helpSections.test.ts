/**
 * @file help's sections: the table of contents, a section by its one
 * capitalised word, the Shell topics, and apropos ranking.
 */
import { describe, it, expect } from '@jest/globals';
import { apropos_search, helpPosix_render, helpSection_render, helpToc_render, section_find, sectionCommands_list, shellTopic_render, HELP_SECTIONS, type HelpLookup } from '../src/builtins/helpSections.js';

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const summaries: Record<string, string> = { ls: 'List a folder', cd: 'Change folder', query: 'Ask a PACS', gather: 'Hold a cohort', dcm: 'DICOM tags', wtf: 'What an acronym means' };
const sections: Record<string, string> = { ls: 'Navigation', cd: 'Navigation', query: 'PACS', gather: 'Workflows', dcm: 'Imaging' };
const lookup = (commands: string[]): HelpLookup => ({
  commands: () => commands,
  summary: (name) => summaries[name],
  text: (name) => (name === 'wtf' ? 'acronyms like DICOM and PACS' : ''),
  section: (name) => sections[name] ?? (name === 'wtf' ? 'Games' : undefined),
  games: () => ['wtf'],
  posix: (name) => (name === 'ls' ? { group: 'Files', differs: 'lists CFS' } : undefined),
});

describe('the table of contents', () => {
  it('lists the sections this session has commands in, with counts and runnable examples, then Shell', () => {
    const toc: string = strip(helpToc_render(lookup(['ls', 'cd', 'query', 'gather', 'dcm', 'wtf'])));
    expect(toc).toContain('Navigation  (2)');
    expect(toc).toContain('e.g.  cd  ls');
    expect(toc).toContain('PACS  (1)');
    expect(toc).not.toContain('Admin');
    expect(toc).toContain('Shell');
    expect(toc).toContain('Start here:');
    expect(strip(helpToc_render(lookup(['ls', 'cd'])))).not.toContain('Start here:');
  });
});

describe('a section by its word', () => {
  it('takes the capitalised word, and lower case only where no command has the name', () => {
    const isCommand = (name: string): boolean => ['pacs', 'files'].includes(name);
    expect(section_find('PACS', isCommand)?.name).toBe('PACS');
    expect(section_find('pacs', isCommand)).toBeUndefined();
    expect(section_find('navigation', isCommand)?.name).toBe('Navigation');
    expect(section_find('shell', isCommand)?.name).toBe('Shell');
    expect(section_find('nothing', isCommand)).toBeUndefined();
  });

  it('pages a section\'s commands, and the Shell section\'s topics', () => {
    const navigation = HELP_SECTIONS.find((one) => one.name === 'Navigation');
    expect(strip(helpSection_render(navigation as never, lookup(['ls', 'cd', 'query'])))).toMatch(/ls +List a folder/);
    expect(sectionCommands_list('Games', lookup(['ls']))).toEqual(['wtf']);
    const shell = section_find('Shell', () => false);
    expect(strip(helpSection_render(shell as never, lookup([])))).toMatch(/handles +@SER3/);
    expect(strip(shellTopic_render('pipes') ?? '')).toContain('PIPES');
    expect(strip(shellTopic_render('operands') ?? '')).toContain('whatif <line> prints that resolution');
    expect(shellTopic_render('grep')).toBeUndefined();
  });
});

describe('apropos', () => {
  it('leads with what names the word in its name or line, then what only mentions it', () => {
    const hits: string[] = apropos_search('dicom', lookup(['ls', 'dcm', 'wtf'])).map(strip);
    expect(hits[0]).toContain('Imaging (section)');
    expect(hits.findIndex((line) => line.startsWith('dcm'))).toBeLessThan(hits.indexOf('also mentioned in:'));
    expect(hits[hits.length - 1]).toContain('wtf (Games)');
    expect(apropos_search('zzzq', lookup(['ls']))).toEqual([]);
    for (const word of ['operand', 'subject', 'stage', 'whatif']) {
      expect(apropos_search(word, lookup(['ls'])).map(strip).some((line: string): boolean => line.startsWith('operands (Shell)'))).toBe(true);
    }
  });
});

describe('help POSIX', () => {
  it('lists the commands that mirror Unix utilities, by group, with how each differs, and the TOC points at it', () => {
    const page: string = strip(helpPosix_render(lookup(['ls', 'cd', 'query'])));
    expect(page).toContain('POSIX');
    expect(page).toMatch(/Files\n +ls +lists CFS/);
    expect(page).toContain('Shell syntax');
    expect(strip(helpToc_render(lookup(['ls'])))).toContain('POSIX');
    expect(section_find('POSIX', () => false)?.name).toBe('POSIX');
  });
});
