/**
 * @file What a `new` line declares, kept on the host (docs/stratus.adoc,
 * D16): one folder per name, holding `spec.yaml` (the line's record, written
 * by `new`, never by hand), `state.json` (what was built, and the cloud's
 * handles on it) and the files a build leaves (`plan.json`). Networks and
 * VMs keep theirs the same way, each under its own root.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';

/** What every kept record carries. */
export interface KeptRecord {
  name: string;
  created: string;
  /** The region it is built in: the session's when it was declared. */
  region: string;
}

/** How a spec is written and read. */
export interface SpecCodec<Spec> {
  /** What is kept, in a word (`network`), for the refusals. */
  readonly noun: string;
  render(name: string, spec: Spec): string;
  parse(text: string): { spec: Spec } | { error: string };
}

/**
 * Writes a file whole or not at all, readable by its owner only.
 *
 * @param file - Where.
 * @param text - What.
 */
function file_writeAtomic(file: string, text: string): void {
  const temporary: string = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The things of one kind this daemon declares and builds, on its host. */
export class SpecStore<Spec, Record extends KeptRecord> {
  /**
   * @param root - The folder they live in.
   * @param codec - How their spec is written and read.
   */
  constructor(readonly root: string, protected readonly codec: SpecCodec<Spec>) {}

  /**
   * One's folder.
   *
   * @param name - Its name.
   * @returns Its folder.
   */
  folder_derive(name: string): string {
    return path.join(this.root, name);
  }

  /** The names kept, sorted. */
  names_list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((name: string): boolean => fs.existsSync(path.join(this.root, name, 'state.json'))).sort();
  }

  /**
   * Declares one: writes its spec, and its first state when it has none.
   *
   * @param name - Its name.
   * @param spec - Its spec.
   * @param region - The region a new one is built in.
   * @returns Its record.
   */
  declare(name: string, spec: Spec, region: string): Record {
    const folder: string = this.folder_derive(name);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    file_writeAtomic(path.join(folder, 'spec.yaml'), this.codec.render(name, spec));
    const kept: Record | null = this.record_read(name);
    if (kept !== null) return kept;
    const record = { name, created: new Date().toISOString(), region } as Record;
    this.record_write(record);
    return record;
  }

  /**
   * One's state.
   *
   * @param name - Its name.
   * @returns Its record, or null when none is kept.
   */
  record_read(name: string): Record | null {
    const file: string = path.join(this.folder_derive(name), 'state.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record;
  }

  /**
   * Saves one's state.
   *
   * @param record - Its record.
   */
  record_write(record: Record): void {
    file_writeAtomic(path.join(this.folder_derive(record.name), 'state.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Changes one's state and saves it.
   *
   * @param name - Its name.
   * @param change - What to change.
   * @returns The record as saved.
   * @throws Error - When none is kept.
   */
  record_update(name: string, change: (record: Record) => void): Record {
    const record: Record | null = this.record_read(name);
    if (record === null) throw new Error(`${name}: no such ${this.codec.noun}`);
    change(record);
    this.record_write(record);
    return record;
  }

  /**
   * One's spec.
   *
   * @param name - Its name.
   * @returns The spec, or why it does not read, or null when there is no file.
   */
  spec_read(name: string): { spec: Spec } | { error: string } | null {
    const file: string = path.join(this.folder_derive(name), 'spec.yaml');
    if (!fs.existsSync(file)) return null;
    return this.codec.parse(fs.readFileSync(file, 'utf-8'));
  }

  /**
   * Writes one of its own files (`plan.json`), whole.
   *
   * @param name - Its name.
   * @param file - The file's name in its folder.
   * @param text - Its content.
   */
  file_write(name: string, file: string, text: string): void {
    file_writeAtomic(path.join(this.folder_derive(name), file), text);
  }

  /**
   * Reads one of its own files.
   *
   * @param name - Its name.
   * @param file - The file's name in its folder.
   * @returns Its content, or null when it is not there.
   */
  file_read(name: string, file: string): string | null {
    const where: string = path.join(this.folder_derive(name), file);
    return fs.existsSync(where) ? fs.readFileSync(where, 'utf-8') : null;
  }

  /**
   * Removes one of its own files; one not there is no error.
   *
   * @param name - Its name.
   * @param file - The file's name in its folder.
   */
  file_remove(name: string, file: string): void {
    fs.rmSync(path.join(this.folder_derive(name), file), { force: true });
  }
}
