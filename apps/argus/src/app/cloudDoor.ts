/**
 * @file The door into cloud management: the question asked as a person
 * enters, the way trek asks its settings before the first turn.
 *
 * A stratus session is read-only or may manage the tenancy (build, tear
 * down, spend), and which it is gets fixed when porter starts it: nothing
 * inside the session can raise it later (docs/stratus.adoc, D10). So the
 * question is put at the door, in front of the person entering, on both
 * surfaces alike: in the console `stratus oci` asks it and `stratus oci
 * read|manage` answers it in words; on the dashboard the CLOUD tile runs the
 * same line. Consent to each act (the lock, the name typed back) stays at
 * the act.
 *
 * @module
 */

/** How a stratus session is entered: looking only, or able to act. */
export type CloudEntry = 'read' | 'manage';

/** The two ways in, as the question explains them. */
const ENTRY_LINES: ReadonlyArray<string> = [
  'read     look only: the tenancy, what is built in it, its cost; nothing outside this host changes',
  'manage   act as well: build, tear down and spend, each after its own lock and the name typed back',
];

/**
 * Asks how the cloud session should be entered: a sheet over the surface
 * with READ and MANAGE, answered by a press, Enter on the lit one, or the
 * answer's first letter; Escape is NOT NOW.
 *
 * @param cloud - The cloud entered (`oci`), for the heading.
 * @returns The entry chosen, or null for not now.
 */
export function password_ask(line: string, user: string | null): Promise<string | null> {
  document.querySelector('.share-sheet')?.remove();
  const sheet: HTMLElement = document.createElement('div');
  sheet.className = 'share-sheet cloud-ask cloud-elevate';
  sheet.id = 'cloud-elevate-sheet';
  sheet.setAttribute('role', 'dialog');
  const head: HTMLElement = document.createElement('div');
  head.className = 'share-head';
  head.textContent = `MANAGE · ${user === null ? 'YOUR' : `${user.toUpperCase()}'S`} PASSWORD`;
  const text: HTMLPreElement = document.createElement('pre');
  text.className = 'share-script';
  text.textContent = [
    `${line}`,
    '',
    'This session was entered as READ: nothing outside this host changes.',
    'That line would act. Your password, checked at the door you logged in by, makes this',
    'session MANAGE until you leave it; it crosses once and is kept nowhere.',
  ].join('\n');
  const field: HTMLInputElement = document.createElement('input');
  field.type = 'password';
  field.className = 'cloud-password';
  field.autocomplete = 'current-password';
  field.setAttribute('aria-label', 'Password');
  const pill = (label: string, className: string): HTMLButtonElement => {
    const button: HTMLButtonElement = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  };
  const go: HTMLButtonElement = pill('MANAGE', 'share-copy cloud-manage');
  const cancel: HTMLButtonElement = pill('NOT NOW', 'share-close');
  const pills: HTMLElement = document.createElement('div');
  pills.className = 'share-pills';
  pills.append(go, cancel);
  sheet.append(head, text, field, pills);
  document.body.appendChild(sheet);
  field.focus();
  return new Promise((resolve: (password: string | null) => void): void => {
    const settle = (password: string | null): void => { field.value = ''; sheet.remove(); resolve(password); };
    go.addEventListener('click', (): void => settle(field.value === '' ? null : field.value));
    cancel.addEventListener('click', (): void => settle(null));
    field.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Enter') settle(field.value === '' ? null : field.value); });
    sheet.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Escape') settle(null); });
  });
}

/**
 * The sheet that asked READ or MANAGE at the door. Kept for a session
 * whose daemon cannot be raised (no door named), where the answer is still
 * fixed when porter starts it.
 *
 * @param cloud - The cloud entered (`oci`), for the heading.
 * @returns The entry chosen, or null for not now.
 */
export function cloudEntry_ask(cloud: string): Promise<CloudEntry | null> {
  document.querySelector('.share-sheet')?.remove();
  const sheet: HTMLElement = document.createElement('div');
  sheet.className = 'share-sheet cloud-ask';
  sheet.setAttribute('role', 'dialog');
  const head: HTMLElement = document.createElement('div');
  head.className = 'share-head';
  head.textContent = `CLOUD MANAGEMENT · ${cloud.toUpperCase()} · ENTER TO READ, OR TO MANAGE?`;
  const text: HTMLPreElement = document.createElement('pre');
  text.className = 'share-script';
  text.textContent = ENTRY_LINES.join('\n');
  const pill = (label: string, className: string): HTMLButtonElement => {
    const button: HTMLButtonElement = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  };
  const read: HTMLButtonElement = pill('READ', 'share-copy cloud-read');
  const manage: HTMLButtonElement = pill('MANAGE', 'share-copy cloud-manage');
  const cancel: HTMLButtonElement = pill('NOT NOW', 'share-close');
  const pills: HTMLElement = document.createElement('div');
  pills.className = 'share-pills';
  pills.append(read, manage, cancel);
  sheet.append(head, text, pills);
  document.body.appendChild(sheet);
  read.focus();
  return new Promise((resolve: (entry: CloudEntry | null) => void): void => {
    const settle = (entry: CloudEntry | null): void => { sheet.remove(); resolve(entry); };
    read.addEventListener('click', (): void => settle('read'));
    manage.addEventListener('click', (): void => settle('manage'));
    cancel.addEventListener('click', (): void => settle(null));
    sheet.addEventListener('keydown', (event: KeyboardEvent): void => {
      const key: string = event.key.toLowerCase();
      if (key === 'escape') settle(null);
      else if (key === 'r') settle('read');
      else if (key === 'm') settle('manage');
    });
  });
}
