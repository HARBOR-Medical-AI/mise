/**
 * @file What the console host hands its modules: the layout, the panel
 * roster, the subject bus, the dormant groups, the sound, and — made after
 * the modules that use them — the terminal and the client, read when
 * called, never at wiring.
 *
 * A module of the host is a function `x_wire(context)` that returns its
 * verbs; the host assembles them. A module names in its own `Pick` the part
 * of the context it reads, so what it touches is in its signature.
 */
import type { ArgusClient } from '../calypso/client.js';
import type { ArgusTerminal } from '../console/terminal.js';
import type { DormantRegistry } from './dormant.js';
import type { LayoutManager } from './layout.js';
import type { PaneInstance, PanelRoster } from './panes.js';
import type { SubjectBus } from './subjects.js';

/** The host, as its modules read it. */
export interface HostContext {
  /** The split tree of panes on stage. */
  layout: LayoutManager;
  /** The live panel controllers, by pane id. */
  panels: PanelRoster;
  /** The pane instances (mounts) by id. */
  paneInstance_get: (id: string) => PaneInstance | undefined;
  /** Pane linkage as hub-and-spoke subjects. */
  subjects: SubjectBus;
  /** Groups that have left the stage, kept to come back. */
  dormant: DormantRegistry;
  /** Plays one of the frame's sounds, when sound is on. */
  sound: (audioId: string) => void;
  /** The console; made after most modules are wired, so read when needed. */
  readonly terminal: ArgusTerminal;
  /** The session's wire; made last, so read when needed. */
  readonly client: ArgusClient;
  /** The answer at the cloud door: true for MANAGE, false for READ, null when the session has no such door (docs/stratus.adoc, D14). */
  manage_is: () => boolean | null;
}
