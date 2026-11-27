/**
 * @file SHARE VIEW: the stage as a script another operator can replay
 * (law a-view-is-a-script).
 *
 * A view is shared as console lines: a baseline (`desktop clear`, the
 * dashboard every session starts at) and then the steps a desktop records
 * from there — the panes, the feed on a graph, its modes, the job it
 * stands on. Replayed from the baseline, the same lines give the same view
 * whatever the receiver had on screen. The sheet shows the script and
 * copies it, and says what happened, as LINK does.
 *
 * @module
 */
import { script_commands } from '@fnndsc/menu';
import { more_wire } from '../features/roster/more.js';

/**
 * The line that says a view's values are written quoted (`arg_quote`), and
 * are to be read so. A view without it is from before values were quoted:
 * its lines are read as they were then, word by word at each space, so a
 * folder kept with an apostrophe in its name still opens.
 */
export const VIEW_QUOTED_MARK: string = '# lines: quoted';

/** The line every shared view starts from. */
export const VIEW_BASELINE: string = 'desktop clear';

/**
 * A shared view's script: what it is, the baseline, then the steps.
 *
 * @param steps - The stage as a desktop serializes it.
 * @returns The script.
 */
export function viewScript_compose(steps: string): string {
  // The steps are read as the replay reads them: a command ends at a newline outside quotes, so a folder
  // whose name holds a blank line or a `#` goes into the script whole.
  return ['# ARGUS view: run these lines in the ARGUS console to see what I see', VIEW_QUOTED_MARK, VIEW_BASELINE, ...script_commands(steps)].join('\n');
}

/** How long the sheet's COPY says COPIED. */
const SHARE_ANNOUNCE_MS: number = 2500;

/**
 * Stands the share sheet over the stage: the script, COPY and CLOSE. The
 * script is copied at once; the pill says whether the browser took it,
 * and the text is selected for the hand where it did not.
 *
 * @param script - The view's script.
 * @param clipboard - The clipboard; the browser's own by default.
 * @returns The sheet.
 */
export function shareSheet_open(script: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard): HTMLElement {
  document.querySelector('.share-sheet')?.remove();
  const sheet: HTMLElement = document.createElement('div');
  sheet.className = 'share-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'share this view');
  const head: HTMLElement = document.createElement('div');
  head.className = 'share-head';
  head.textContent = 'SHARE VIEW · THESE LINES, OR THE LINK, PUT ANYONE WHERE YOU ARE';
  const text: HTMLPreElement = document.createElement('pre');
  text.className = 'share-script';
  text.textContent = script;
  const copy: HTMLButtonElement = document.createElement('button');
  copy.type = 'button';
  copy.className = 'share-copy share-lines';
  copy.textContent = 'COPY';
  const linkCopy: HTMLButtonElement = document.createElement('button');
  linkCopy.type = 'button';
  linkCopy.className = 'share-copy share-link';
  linkCopy.textContent = 'COPY LINK';
  const close: HTMLButtonElement = document.createElement('button');
  close.type = 'button';
  close.className = 'share-close';
  close.textContent = 'CLOSE';
  const pills: HTMLElement = document.createElement('div');
  pills.className = 'share-pills';
  pills.append(linkCopy, copy, close);
  sheet.append(head, text, pills);
  document.body.appendChild(sheet);
  // A long script scrolls in its box and says it holds more; the chip
  // stands on the sheet, never inside the lines it would be copied with.
  more_wire(text, { mount: sheet });

  let shown: number = 0;
  const copy_run = async (): Promise<void> => {
    let took: boolean = false;
    try {
      if (clipboard === undefined) throw new Error('no clipboard');
      await clipboard.writeText(script);
      took = true;
    } catch {
      const selection: Selection | null = window.getSelection();
      if (selection !== null) {
        const range: Range = document.createRange();
        range.selectNodeContents(text);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    sheet.dataset['copied'] = took ? 'yes' : 'no';
    copy.textContent = took ? 'COPIED' : 'SELECT + COPY';
    const at: number = ++shown;
    window.setTimeout((): void => {
      if (at !== shown) return;
      delete sheet.dataset['copied'];
      copy.textContent = 'COPY';
    }, SHARE_ANNOUNCE_MS);
  };
  copy.addEventListener('click', (): void => { void copy_run(); });
  // The same view as one link: opened, it shows these lines and asks.
  linkCopy.addEventListener('click', (): void => {
    const link: string = viewLink_compose(window.location.origin, script);
    void (clipboard === undefined ? Promise.reject(new Error('no clipboard')) : clipboard.writeText(link)).then(
      (): void => { linkCopy.textContent = 'LINK COPIED'; },
      (): void => { text.textContent = link; linkCopy.textContent = 'LINK SHOWN: SELECT + COPY'; },
    ).finally((): void => {
      window.setTimeout((): void => { linkCopy.textContent = 'COPY LINK'; }, SHARE_ANNOUNCE_MS);
    });
  });
  close.addEventListener('click', (): void => sheet.remove());
  sheet.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Escape') sheet.remove();
  });
  void copy_run();
  close.focus();
  return sheet;
}

/** The fragment a view link carries its script under. */
export const VIEW_LINK_KEY: string = 'view=';

/**
 * A link that opens ARGUS and offers a view: the door's address with the
 * script in its fragment, readable (each line in order, URI-escaped), so
 * the receiver can see what they are opening.
 *
 * @param origin - The page's origin.
 * @param script - The view's script.
 * @returns The link.
 */
export function viewLink_compose(origin: string, script: string): string {
  return `${origin.replace(/\/+$/, '')}/#${VIEW_LINK_KEY}${encodeURIComponent(script)}`;
}

/**
 * The script a view link carries, or null when the fragment carries none.
 *
 * @param hash - The address's fragment, `#` included.
 * @returns The script.
 */
export function viewLink_parse(hash: string): string | null {
  if (!hash.startsWith(`#${VIEW_LINK_KEY}`)) return null;
  try {
    const script: string = decodeURIComponent(hash.slice(VIEW_LINK_KEY.length + 1));
    return script.trim() === '' ? null : script;
  } catch {
    return null;
  }
}

/**
 * Asks before a received view runs: its lines, each refused one marked
 * with why, and RUN (withheld while any is refused) or NOT NOW.
 *
 * @param lines - The view's lines, comments and blanks dropped.
 * @param refusals - Why each refused line is refused, by line index.
 * @param from - Where it came from, for the heading.
 * @returns True when the operator chose RUN.
 */
export function viewSheet_ask(lines: ReadonlyArray<string>, refusals: ReadonlyMap<number, string>, from: string): Promise<boolean> {
  document.querySelector('.share-sheet')?.remove();
  const sheet: HTMLElement = document.createElement('div');
  sheet.className = 'share-sheet view-ask';
  sheet.setAttribute('role', 'dialog');
  const head: HTMLElement = document.createElement('div');
  head.className = 'share-head';
  head.textContent = refusals.size > 0
    ? `A VIEW FROM ${from.toUpperCase()} · IT ASKS FOR MORE THAN A VIEW, SO IT WILL NOT RUN`
    : `A VIEW FROM ${from.toUpperCase()} · RUN THESE LINES?`;
  const text: HTMLPreElement = document.createElement('pre');
  text.className = 'share-script';
  lines.forEach((line: string, index: number): void => {
    const row: HTMLElement = document.createElement('div');
    row.textContent = line;
    const refused: string | undefined = refusals.get(index);
    if (refused !== undefined) {
      row.className = 'view-refused';
      row.textContent = `${line}    ← ${refused}`;
    }
    text.appendChild(row);
  });
  const run: HTMLButtonElement = document.createElement('button');
  run.type = 'button';
  run.className = 'share-copy view-run';
  run.textContent = 'RUN';
  run.disabled = refusals.size > 0;
  const cancel: HTMLButtonElement = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'share-close';
  cancel.textContent = 'NOT NOW';
  const pills: HTMLElement = document.createElement('div');
  pills.className = 'share-pills';
  pills.append(run, cancel);
  sheet.append(head, text, pills);
  document.body.appendChild(sheet);
  more_wire(text, { mount: sheet });
  (refusals.size > 0 ? cancel : run).focus();
  return new Promise((resolve: (run: boolean) => void): void => {
    const settle = (answer: boolean): void => { sheet.remove(); resolve(answer); };
    run.addEventListener('click', (): void => settle(true));
    cancel.addEventListener('click', (): void => settle(false));
    sheet.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Escape') settle(false); });
  });
}
