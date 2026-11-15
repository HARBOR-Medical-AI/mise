/**
 * @file Every suite's session has stratus's argument kinds, as the backend
 * registers them: a suite that runs a command over words parses its line
 * against the command's grammar, which names `cluster`, `vm`, `network` and
 * `chrisProfile`. A suite that installs the whole backend replaces this one.
 */
import { backend_install } from '@fnndsc/brasa/core';
import { stratusKinds_make } from '../../src/commands/declared.js';
import { CHRIS_PROFILES } from '../../src/chris/profiles.js';

backend_install({
  id: 'stratus-kinds',
  session: {} as never,
  argumentKinds: stratusKinds_make({ clusters: () => [], vms: () => [], nets: () => [], profiles: () => Object.keys(CHRIS_PROFILES) }),
});
