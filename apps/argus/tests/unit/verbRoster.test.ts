/**
 * @jest-environment jsdom
 */
/**
 * @file Every listing is held to the verb roster, exhaustively.
 *
 * The defect this exists for: a verb was added to the PACS series row and
 * GATHER, the control a whole gather workflow starts with, stopped reaching
 * the operator on every series already in CUBE. Every test stayed green,
 * because no test had ever asked a listing what it offers.
 *
 * So this asks. For each listing that gives its rows verbs, and each row
 * state the roster declares, a real listing is mounted and the capsules it
 * renders are compared against the roster: same verbs, same labels, same
 * order, nothing missing and nothing extra. The comparison is exhaustive by
 * design — an unexpected verb fails as loudly as an absent one, because a
 * verb arriving unannounced is how the last one was displaced.
 *
 * Geometry is not jsdom's to answer. Whether a rendered capsule lands
 * inside the cell holding it is the smoke suite's question.
 *
 * @module
 */
import { describe, it, expect } from '@jest/globals';
import { Listing } from '../../src/features/roster/listing.js';
import type { ListingAction, ListingTrait } from '../../src/features/roster/row.js';
import {
  VERB_ROSTERS,
  verbs_offered,
  type AnyVerbRoster,
  type VerbRoster,
  type VerbRule,
} from '../../src/features/roster/verbs.js';

/** One row carrying nothing but the state under test. */
interface StateRow<F> {
  name: string;
  facts: F;
}

/** A mount with the chrome the façade looks for. */
function host_make(prefix: string): { root: HTMLElement; mount: HTMLElement } {
  const root: HTMLElement = document.createElement('div');
  root.innerHTML = `
    <span class="pane-state"></span>
    <button class="${prefix}-filter">FILTER OFF</button>
    <div class="mount"></div>
  `;
  document.body.appendChild(root);
  return { root, mount: root.querySelector<HTMLElement>('.mount') as HTMLElement };
}

/**
 * Mounts a real listing of one row in one state and reads back the verbs it
 * renders.
 *
 * The actions are built the way every pane now builds them: filter the
 * roster by what the row is, label from the rule. What a verb runs is the
 * pane's and is not exercised here.
 *
 * @param roster - The listing's roster.
 * @param state - The row state to render.
 * @returns The rendered capsule labels, in the order they appear.
 */
function rendered_verbs<F>(roster: VerbRoster<F>, state: StateRow<F>): string[] {
  const prefix: string = roster.listing.replace('.', '-');
  const { root, mount } = host_make(prefix);
  const traits: ReadonlyArray<ListingTrait<StateRow<F>>> = [
    { key: 'state', label: 'STATE', className: 'state', width: '1fr', cell: (row: StateRow<F>): string => row.name },
  ];
  const listing: Listing<StateRow<F>> = new Listing<StateRow<F>>({
    mount,
    traits,
    key: (row: StateRow<F>): string => row.name,
    chrome: { root, prefix },
    actions: {
      width: '20em',
      always: true,
      of: (row: StateRow<F>): ReadonlyArray<ListingAction<StateRow<F>>> =>
        roster.rules
          .filter((rule: VerbRule<F>): boolean => rule.offered(row.facts))
          .map((rule: VerbRule<F>): ListingAction<StateRow<F>> => ({
            label: rule.label(row.facts),
            run: (): void => undefined,
          })),
    },
  });
  listing.rows_set([{ key: 'block', rows: [state] }], { field: roster.listing });
  const labels: string[] = [...mount.querySelectorAll('.listing-actions button')]
    .map((button: Element): string => (button.textContent ?? '').trim());
  root.remove();
  return labels;
}

describe('the verb roster', () => {
  it('covers every listing that gives its rows verbs', () => {
    expect(VERB_ROSTERS.map((roster: AnyVerbRoster): string => roster.listing)).toEqual([
      'files.row',
      'files.selection',
      'runs.row',
      'pacs.patient',
      'pacs.study',
      'pacs.series',
      'gather.cohort',
      'gather.series',
    ]);
  });

  it('names each verb once per listing, so a pane binds an unambiguous name', () => {
    for (const any of VERB_ROSTERS) {
      any.visit(<F,>(roster: VerbRoster<F>): void => {
        const names: string[] = roster.rules.map((rule: VerbRule<F>): string => rule.name);
        expect(new Set(names).size).toBe(names.length);
        expect(roster.states.length).toBeGreaterThan(0);
      });
    }
  });
});

describe('what a listing renders', () => {
  for (const any of VERB_ROSTERS) {
    any.visit(<F,>(roster: VerbRoster<F>): void => {
      describe(roster.listing, () => {
        for (const state of roster.states) {
          it(`offers exactly the roster's verbs for ${state.name}`, () => {
            // Exhaustive and ordered: toEqual on arrays fails on a missing
            // verb, an extra one, a relabelled one, and a reordered one.
            expect(rendered_verbs(roster, state)).toEqual(verbs_offered(roster, state.facts));
          });
        }
      });
    });
  }
});

/**
 * The contract, written out.
 *
 * Deriving the expectation from the roster proves the façade renders what
 * was declared, which is worth proving and is not the whole job: it would
 * accept a verb quietly added to the roster as readily as the pane once
 * accepted one. So the surface's verbs are also written here, by hand, and
 * a change to any of them has to be made twice — once where it acts, once
 * here, where a reader can see what a row is offered without running
 * anything. That second edit is the announcement.
 */
const CONTRACT: Readonly<Record<string, Readonly<Record<string, string[]>>>> = {
  'files.row': {
    // LINK on every row but a catalogue entry: a web address that opens
    // ARGUS at the row's path, for a colleague the feed is shared with.
    // A file can be gathered: CUBE's unextpath takes files as well as
    // directories, so three-and-only-three files is a cohort a run can
    // be given. Proved live before the verb was offered.
    'a plain file outside a feed': ['GATHER', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE'],
    'a file inside a feed': ['GATHER', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE', 'SHARE FEED 12'],
    // A place can be gathered: a cohort is what the session is working on,
    // and that is not only PACS.
    // A folder downloads as one archive: a browser has no directory to fill.
    'a directory': ['GATHER', 'PROCESS', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE'],
    // Gatherable even though it cannot be PROCESSed: the kernel runs on a
    // whole node, so a directory beneath one is no input — but it is still
    // a place a cohort can hold.
    'a directory inside a feed that is not a node': ['GATHER', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE', 'SHARE FEED 12'],
    "a node's data inside a feed": ['GATHER', 'PROCESS', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE', 'SHARE FEED 12'],
    'a DICOM series folder': ['IMAGE', 'GATHER', 'PROCESS', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE'],
    'a catalogue entry': [],
    'a catalogue entry in a bound catalogue': ['RUN'],
    // A projection is rendered by the kernel and written by nothing: there
    // is no folder behind /proc to move into, copy within or remove from,
    // and CUBE grants a feed on a feed's own path, not on a view of it.
    // What a projection IS for stays: reading, opening, processing.
    "a node's data seen through /proc": ['PROCESS', 'LINK'],
    'a file seen through /proc': ['DOWNLOAD', 'LINK'],
    'a text file': ['GATHER', 'EDIT', 'DOWNLOAD', 'LINK', 'MOVE', 'COPY', 'DELETE'],
    "a feed's note seen through /proc": ['EDIT', 'DOWNLOAD', 'LINK'],
  },
  'files.selection': {
    'a selection outside any feed': ['DELETE 3', 'MOVE 3', 'COPY 3'],
    'a selection in one feed': ['DELETE 2', 'MOVE 2', 'COPY 2', 'SHARE FEED 12'],
    'a selection spanning feeds': ['DELETE 5', 'MOVE 5', 'COPY 5', 'SHARE 2 FEEDS'],
  },
  'runs.row': {
    'any feed': ['NOTE', 'TAG', 'RENAME', 'SHARE', 'DELETE'],
  },
  'pacs.patient': {
    // Each level's pull names its level, so the capsule says how much it fetches.
    'a patient with studies': ['PULL PATIENT'],
    'a patient with none': [],
  },
  'pacs.study': {
    // A study with a path can be gathered: its addressable series are the
    // cohort's targets, whether or not any of them is home yet.
    'a study with a path': ['PULL STUDY', 'GATHER'],
    'a study with none': [],
    // A study with something home can be gathered; one with everything home
    // can also be processed as a folder. A study with nothing home is
    // pulled — and pulling is a fetch, not a choice: it gathers nothing.
    'a study wholly home': ['PULL STUDY', 'GATHER', 'PROCESS'],
    'a study partly home': ['PULL STUDY', 'GATHER'],
  },
  'pacs.series': {
    'not yet retrieved': ['GATHER', 'PULL SERIES'],
    'not retrieved and unaddressable': ['PULL SERIES'],
    'home, folder not yet named': ['GATHER'],
    'home, folder named': ['GATHER', 'IMAGE', 'DIR', 'PROCESS'],
  },
  'gather.cohort': {
    'holding series': ['SAVE', 'EXPORT CSV', 'CREATE FEED', 'PROCESS', 'DISMISS'],
    'holding series, rooted in a feed': ['SAVE', 'EXPORT CSV', 'PROCESS', 'DISMISS'],
    'emptied': ['DISMISS'],
  },
  'gather.series': {
    'folder named': ['REMOVE', 'IMAGE', 'PROCESS'],
    // A gathered directory that is not a series folder: processable, not
    // viewable, since IMAGE on a folder of tables cannot act.
    'a place that is not imagery': ['REMOVE', 'PROCESS'],
    // PROCESS is offered on every member — a verb that appears only on the
    // rows that happen to be home reads as a listing changing its mind —
    // and refuses by name on one that is not in CUBE yet.
    'folder not yet named': ['REMOVE', 'PROCESS'],
    // A member that is not home is offered the fetch, on its own row: the
    // frame pulls the whole cohort, the row pulls this one.
    'not retrieved yet': ['REMOVE', 'PULL SERIES', 'PROCESS'],
  },
};

describe('the surface offers what the contract says it offers', () => {
  it('names every listing and every state, and no more', () => {
    const declared: Record<string, string[]> = {};
    for (const any of VERB_ROSTERS) {
      any.visit(<F,>(roster: VerbRoster<F>): void => {
        declared[roster.listing] = roster.states.map((one: { name: string }): string => one.name);
      });
    }
    expect(Object.keys(declared).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const [listing, states] of Object.entries(declared)) {
      expect(states.sort()).toEqual(Object.keys(CONTRACT[listing] ?? {}).sort());
    }
  });

  for (const any of VERB_ROSTERS) {
    any.visit(<F,>(roster: VerbRoster<F>): void => {
      for (const state of roster.states) {
        it(`${roster.listing}: ${state.name}`, () => {
          expect(rendered_verbs(roster, state)).toEqual(CONTRACT[roster.listing]?.[state.name]);
        });
      }
    });
  }
});

describe('the PACS series row, where the verb went missing', () => {
  const series = VERB_ROSTERS.find((one: AnyVerbRoster): boolean => one.listing === 'pacs.series') as AnyVerbRoster;

  it('offers the gather and the image once a series is home, and withdraws the pull', () => {
    series.visit(<F,>(roster: VerbRoster<F>): void => {
      const home = roster.states.find((one: { name: string }): boolean => one.name === 'home, folder named');
      expect(home).toBeDefined();
      if (home === undefined) return;
      expect(rendered_verbs(roster, home)).toEqual(['GATHER', 'IMAGE', 'DIR', 'PROCESS']);
    });
  });

  it('offers the gather and the pull before a series is home, and nothing that needs a folder', () => {
    // Two different acts: GATHER marks it as a target of the cohort, PULL
    // brings this one now. IMAGE, DIR and PROCESS still wait for CUBE to
    // say where it landed.
    series.visit(<F,>(roster: VerbRoster<F>): void => {
      const away = roster.states.find((one: { name: string }): boolean => one.name === 'not yet retrieved');
      expect(away).toBeDefined();
      if (away === undefined) return;
      expect(rendered_verbs(roster, away)).toEqual(['GATHER', 'PULL SERIES']);
    });
  });
});
