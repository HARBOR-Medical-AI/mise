/**
 * @file The PACS query index: what has already been asked, and answered.
 *
 * CUBE keeps every PACS query it has run, criteria and result both, so a
 * question asked before need not be asked again. It cannot be *searched*
 * for, though: the queries collection accepts no parameter over the stored
 * criteria, and every row of every page drags its compressed result along —
 * kilobytes each, thousands of rows. Looking a question up by sweeping that
 * collection would cost megabytes, and would cost them most often on a
 * MISS, which is the common case for a genuinely new query. A client that
 * searched naively would make every new query slower than not searching.
 *
 * So the collection is walked once, in the background, and what is learned
 * is kept here: criteria and server in, the stored query's id out. A lookup
 * is then a map read.
 *
 * The index is ADVISORY. A hit is a claim to be confirmed — the caller
 * decodes the stored result before serving it, and any failure (the query
 * deleted, the result unreadable) falls through to a fresh query. A stale
 * entry can therefore cost a wasted lookup and never a wrong answer, which
 * is what makes it safe to keep across restarts and to fill lazily.
 *
 * It is also the log itself. Each entry carries the criteria and owner the
 * VFS renders into `/net/pacs/queries/<name>`, so that listing can be
 * served from here — complete, rather than the first page of it.
 *
 * @module
 */

import { identityCache_usable, identityChange_listen } from '../connect/identityEpoch';

/**
 * Separates the server from the criteria in a key, and one criterion from
 * the next.
 *
 * ASCII record and unit separators, written as escapes: a PACS identifier
 * or a DICOM value may contain anything printable — including the spaces,
 * colons and commas that would otherwise let two different questions
 * collide on one key.
 */
const KEY_SERVER_SEPARATOR: string = '\u001e';

/** Separates one criterion from the next in a key. */
const KEY_PAIR_SEPARATOR: string = '\u001f';

/** What the index knows about one stored query. */
export interface QueryIndexEntry {
  /** The stored CUBE query's id — what a replay decodes. */
  queryId: number;
  /** The PACS this was asked of; part of the key, kept for the listing. */
  server: string;
  /** The criteria as asked, for rebuilding the log's display name. */
  criteria: Record<string, string>;
  /** Who asked. Part of the log's display name. */
  owner: string;
  /** When the query record was created — the age a replay states. */
  answeredAt: string;
  /**
   * Whether it found anything.
   *
   * A query that found nothing is indexed *as such* rather than omitted,
   * so a replay can refuse it knowingly. An absence decays where a hit does
   * not: the patient is scanned next week, and "no imaging found" is the
   * answer a clinician acts on.
   */
  hasResult: boolean;
}

/** One entry with the key it is filed under. */
export interface QueryIndexEntrySnapshot extends QueryIndexEntry {
  key: string;
}

/** The whole index, and how far the back-fill has walked. */
export interface QueryIndexSnapshot {
  entries: QueryIndexEntrySnapshot[];
  /**
   * The oldest record the back-fill has reached, as an ISO timestamp.
   *
   * The sweep walks newest first, so this is where it resumes — everything
   * newer is already held. Null before the first sweep.
   */
  floor: string | null;
}

/** Told after any mutation, so a checkpoint writer can debounce on it. */
export type QueryIndexListener = () => void;

/**
 * Builds the key a question is filed under.
 *
 * Two questions are the same question when their criteria sets are equal
 * and they were asked of the same PACS. Key order and surrounding
 * whitespace are normalized away because they are how the question was
 * *typed*, not what it asked. Values are otherwise left exactly as given:
 * they are the PACS's own vocabulary, and mise does not get to reinterpret
 * them — a case fold here would silently claim that two DICOM values match
 * when only the PACS can say so.
 *
 * The owner is part of the question. The index holds the whole log —
 * every identity's queries, because that is what `/net/pacs/queries` lists
 * — while a replay may only ever serve back an answer to the identity that
 * asked for it. Keying by owner makes those two facts one lookup instead of
 * a filter somebody can forget.
 *
 * @param criteria - The criteria as asked.
 * @param server - The PACS identifier the query was asked of.
 * @param owner - The identity that asked.
 * @returns The key, stable for equal questions.
 */
export function queryKey_build(
  criteria: Record<string, string>,
  server: string,
  owner: string,
): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(criteria)) {
    const key: string = name.trim();
    const held: string = String(value ?? '').trim();
    if (key.length === 0 || held.length === 0) continue;
    pairs.push(`${key}=${held}`);
  }
  pairs.sort();
  return `${owner.trim()}${KEY_SERVER_SEPARATOR}${server.trim()}${KEY_SERVER_SEPARATOR}${pairs.join(KEY_PAIR_SEPARATOR)}`;
}

/**
 * Parses the criteria CUBE stores as a JSON string on a query record.
 *
 * @param raw - The record's `query` field.
 * @returns The criteria, or null when the field is absent or unparseable.
 */
export function queryCriteria_parse(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const criteria: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      criteria[name] = String(value);
    }
    return criteria;
  } catch {
    return null;
  }
}

/**
 * What has already been asked of which PACS, and where the answer is kept.
 */
export class QueryIndex {
  /**
   * Every record, by its query id. This is the log: asking the same thing
   * twice leaves two records, and both remain reachable.
   */
  private entries: Map<number, QueryIndexEntry> = new Map();
  /**
   * Question to the newest record answering it. This is the lookup: a
   * replay wants the most recent answer, not every answer.
   */
  private byQuestion: Map<string, number> = new Map();
  private floor: string | null = null;
  private listeners: Set<QueryIndexListener> = new Set();

  /**
   * Files a query under its question.
   *
   * The newest answer to a question wins: asking the same thing twice
   * leaves the later record indexed, which is the one whose age a replay
   * should state.
   *
   * @param entry - What was asked, of whom, and what came back.
   */
  public entry_note(entry: QueryIndexEntry): void {
    // A query made as another user, or noted by work begun under an identity since replaced, is not this
    // identity's to replay.
    if (!identityCache_usable()) return;
    this.entries.set(entry.queryId, entry);
    const key: string = queryKey_build(entry.criteria, entry.server, entry.owner);
    const heldId: number | undefined = this.byQuestion.get(key);
    const held: QueryIndexEntry | undefined = heldId === undefined ? undefined : this.entries.get(heldId);
    // Strictly newer, so a tie leaves the incumbent in place: what this
    // process learned outranks what a restored checkpoint claims.
    if (held === undefined || Date.parse(entry.answeredAt) > Date.parse(held.answeredAt)) {
      this.byQuestion.set(key, entry.queryId);
    }
    this.change_emit();
  }

  /**
   * Looks a question up.
   *
   * @param criteria - The criteria being asked.
   * @param server - The PACS being asked.
   * @param owner - The identity asking; another identity's answer is not
   *   an answer to this question.
   * @returns What is known, or null when this question is new to the index.
   */
  public entry_find(
    criteria: Record<string, string>,
    server: string,
    owner: string,
  ): QueryIndexEntry | null {
    const queryId: number | undefined = this.byQuestion.get(queryKey_build(criteria, server, owner));
    if (queryId === undefined) return null;
    return this.entries.get(queryId) ?? null;
  }

  /**
   * Forgets one query, for when its stored answer turns out to be gone.
   *
   * @param criteria - The criteria it was filed under.
   * @param server - The PACS it was asked of.
   * @param owner - The identity that asked.
   */
  public entry_drop(criteria: Record<string, string>, server: string, owner: string): void {
    const key: string = queryKey_build(criteria, server, owner);
    const queryId: number | undefined = this.byQuestion.get(key);
    if (queryId === undefined) return;
    this.byQuestion.delete(key);
    this.entries.delete(queryId);
    // An older record may still answer this question; the newest of what
    // is left takes the pointer back.
    let heir: QueryIndexEntry | null = null;
    for (const entry of this.entries.values()) {
      if (queryKey_build(entry.criteria, entry.server, entry.owner) !== key) continue;
      if (heir === null || Date.parse(entry.answeredAt) > Date.parse(heir.answeredAt)) heir = entry;
    }
    if (heir !== null) this.byQuestion.set(key, heir.queryId);
    this.change_emit();
  }

  /**
   * Every record, for the callers that render the log rather than search it.
   *
   * This is the whole log — every query, not one per question — because
   * that is what `/net/pacs/queries` lists and what an operator went
   * looking for when they could not find a query they knew they had run.
   */
  public entries_all(): QueryIndexEntry[] {
    return [...this.entries.values()];
  }

  /** How many records the index holds. */
  public size_get(): number {
    return this.entries.size;
  }

  /**
   * Whether the index already holds a record for a query id.
   *
   * A resumed sweep asks this to count what it newly filed apart from the
   * boundary record its inclusive resume re-fetches.
   *
   * @param queryId - The query's numeric id.
   * @returns True when the id is already indexed.
   */
  public has(queryId: number): boolean {
    return this.entries.has(queryId);
  }

  /** How many distinct questions those records answer. */
  public questions_count(): number {
    return this.byQuestion.size;
  }

  /**
   * The newest record held, which is where a resumed sweep starts.
   *
   * A completed sweep has walked everything down to the floor, so the only
   * thing a later boot can be missing is what arrived since. Asking CUBE
   * for records at or after this turns a rebuild into a top-up.
   *
   * @returns An ISO timestamp, or null when the index is empty.
   */
  public newest_get(): string | null {
    let newest: string | null = null;
    for (const entry of this.entries.values()) {
      if (newest === null || Date.parse(entry.answeredAt) > Date.parse(newest)) {
        newest = entry.answeredAt;
      }
    }
    return newest;
  }

  /**
   * The oldest record the back-fill has walked, where it resumes.
   *
   * @returns An ISO timestamp, or null before the first sweep.
   */
  public floor_get(): string | null {
    return this.floor;
  }

  /**
   * Records how far back the sweep has reached.
   *
   * @param at - The oldest record walked, as an ISO timestamp.
   */
  public floor_set(at: string): void {
    if (!identityCache_usable()) return;
    if (this.floor !== null && Date.parse(this.floor) <= Date.parse(at)) return;
    this.floor = at;
    this.change_emit();
  }

  /**
   * Creates a persistence-safe copy.
   *
   * @returns The snapshot.
   */
  public snapshot_create(): QueryIndexSnapshot {
    const entries: QueryIndexEntrySnapshot[] = [];
    for (const entry of this.entries.values()) {
      entries.push({ key: queryKey_build(entry.criteria, entry.server, entry.owner), ...entry });
    }
    return { entries, floor: this.floor };
  }

  /**
   * Merges a snapshot in, keeping anything this process already learned:
   * a query indexed since the checkpoint was written is newer than the
   * checkpoint by definition.
   *
   * @param snapshot - A validated snapshot.
   */
  public snapshot_restore(snapshot: QueryIndexSnapshot): void {
    for (const entry of snapshot.entries) {
      if (this.entries.has(entry.queryId)) continue;
      const { key: _key, ...held } = entry;
      this.entry_note(held);
    }
    if (snapshot.floor !== null && (this.floor === null || Date.parse(snapshot.floor) < Date.parse(this.floor))) {
      this.floor = snapshot.floor;
    }
    this.change_emit();
  }

  /**
   * Registers a listener told after any mutation.
   *
   * @param listener - The listener.
   * @returns A function that removes it.
   */
  public changeListener_add(listener: QueryIndexListener): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  /** Empties the index. For tests, and for a change of identity. */
  public reset(): void {
    this.entries.clear();
    this.byQuestion.clear();
    this.floor = null;
    this.change_emit();
  }

  /** Tells every listener. A listener that throws must not stop the rest. */
  private change_emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

let queryIndex: QueryIndex | null = null;

/**
 * The process-wide query index.
 *
 * @returns The singleton.
 */
export function queryIndex_get(): QueryIndex {
  if (queryIndex === null) {
    const made: QueryIndex = new QueryIndex();
    queryIndex = made;
    // The index is one identity's queries: at a change of identity it is emptied, entries and floor.
    identityChange_listen((): void => { made.reset(); });
  }
  return queryIndex;
}
