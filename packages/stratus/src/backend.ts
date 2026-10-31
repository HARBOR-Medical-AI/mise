/**
 * @file The stratus backend: the descriptor a session over a cloud runs with.
 *
 * One backend for every cloud (docs/stratus.adoc, D1): its id is `stratus`,
 * its filesystem is the tenancy tree over whichever driver it was given, its
 * identity the cloud user at the tenancy. It registers no commands yet and
 * no answer kinds (every row is a folder or a file, D5). Its prompt is the
 * wire's ChRIS-shaped context filled with what a substrate session has, plus
 * the backend-neutral segments of D9 (`prompt.ts`) a surface draws in order.
 *
 * @module
 */
import { commands_register, FileReadRefusal, type Backend, type JobRecord, type JobRun, type PromptLastCommand } from '@fnndsc/brasa/core';
import { VFSDispatcher, type VfsOutcome } from '@fnndsc/fond';
import type { PromptContext } from '@fnndsc/menu';
import type { CloudDriver } from './cloud/driver.js';
import { AnswerCache } from './cache.js';
import { StratusSession } from './session.js';
import { READ_ONLY_REASON, TenancyProvider } from './vfs/tenancy.js';
import { KIND_FOLDERS } from './vfs/resources.js';
import { ClusterTree } from './vfs/clusters.js';
import { shippedManifests_read } from './cluster/manifests.js';
import type { ClusterSource } from './checkout/harborOci.js';
import { stratusCommands_make } from './commands/cluster.js';
import { CAPACITY_CACHE_LIFE_MS } from './commands/capacity.js';
import { stratusListingLook } from './vfs/look.js';
import { stratusSegments_build } from './prompt.js';
import type { CloudBuilder } from './cloud/builder.js';
import type { Installer } from './installer/installer.js';
import type { InstallerAccountKeeper } from './installer/account.js';
import { verifyReach_default, type VerifyReach } from './commands/verify.js';
import type { ChrisWork } from './kube/chris.js';
import { familyShape_find } from './cluster/sizing.js';
import { ClusterStore, clustersRoot_derive, clustersRoot_settle } from './cluster/state.js';
import { clusterExpectSubject_make } from './cluster/expect.js';
import { BUILD_WAITS, buildRun_make, STEPS_SOURCE, type BuildDeps } from './cluster/steps.js';

/** How the backend is made. */
export interface StratusBackendOptions {
  /** The cloud. */
  readonly driver: CloudDriver;
  /** The region the session works in; the credential's home region when absent. */
  readonly region?: string;
  /** Where the working directory is kept. */
  readonly configDir?: string;
  /** How long the tree keeps a cloud answer, in milliseconds. */
  readonly cacheLifeMs?: number;
  /** The clusters this daemon knows, each a `harbor-oci` checkout. */
  readonly clusters?: ReadonlyArray<ClusterSource>;
  /** Where the clusters this daemon builds are kept; `$XDG_STATE_HOME/stratus/clusters` when absent. */
  readonly store?: ClusterStore;
  /** The cloud's build half; absent, this cloud cannot build, adopt or plan, and the verbs say so. With no installer beside it, it adopts and plans but does not build. */
  readonly builder?: CloudBuilder;
  /** The installer the build's steps call. */
  readonly installer?: Installer;
  /** Where the installer's account is kept, so `cluster build` can ask for it when it is missing. */
  readonly account?: InstallerAccountKeeper;
  /** The DNS zone a new cluster's names live under when `cluster new` is not told. */
  readonly baseDomain?: string;
  /** How `cluster verify` reaches a cluster; the network when absent. */
  readonly verifyReach?: VerifyReach;
  /** The build's waits, `harbor-oci`'s when absent. */
  readonly waits?: Pick<BuildDeps, 'pollMs' | 'hostsWaitMs' | 'installWaitMs' | 'verifyWaitMs' | 'chrisWaits'>;
  /** ChRIS on a cluster; the real cluster's, with `helm` and `uv` on the host, when absent. */
  readonly chris?: ChrisWork;
}

/** The backend and the pieces a host may reach into. */
export interface StratusBackend {
  readonly backend: Backend;
  readonly session: StratusSession;
  readonly tenancy: TenancyProvider;
  readonly clusters: ClusterTree;
  readonly store: ClusterStore;
}

/**
 * The paths a session enters without a lookup: the mount, and once the
 * tenancy is known, the tenancy, `regions`, `clusters` and its kind folders.
 *
 * @param session - The session.
 * @returns The structural paths.
 */
export function structuralPaths_list(session: StratusSession): string[] {
  const paths: string[] = ['/', '/net', session.mount];
  if (session.identity === null) return paths;
  const tenancy: string = session.tenancyPath;
  return [...paths, tenancy, `${tenancy}/regions`, `${tenancy}/clusters`, ...KIND_FOLDERS.map((kind: string): string => `${tenancy}/${kind}`)];
}

/**
 * Makes the stratus backend over a driver.
 *
 * @param options - The driver and the session's settings.
 * @returns The backend, ready for `engine_create`, with its session and tree.
 */
export function stratusBackend_make(options: StratusBackendOptions): StratusBackend {
  const session: StratusSession = new StratusSession({ driver: options.driver, region: options.region, configDir: options.configDir });
  const store: ClusterStore = options.store ?? new ClusterStore(clustersRoot_derive());
  if (options.store === undefined) clustersRoot_settle(store.root);
  // The steps run over the cloud's build half and the installer; a cloud with neither cannot build yet.
  const deps: BuildDeps | null = options.builder !== undefined && options.installer !== undefined
    ? {
      store, builder: options.builder, installer: options.installer, zones: 3, version: '4.22', ...(options.waits ?? BUILD_WAITS),
      reach: options.verifyReach ?? verifyReach_default(),
      ...(options.chris !== undefined ? { chris: options.chris } : {}),
      shape_find: async (region: string, family: string): Promise<string | null> => familyShape_find(await options.driver.shapes_list(region), family)?.name ?? null,
    }
    : null;
  const clusters: ClusterTree = new ClusterTree({
    store,
    sources: options.clusters ?? [],
    owner: (): string => session.identity?.user ?? 'disconnected',
    now: (): Date => new Date(),
    manifests: shippedManifests_read(),
  });
  const tenancy: TenancyProvider = new TenancyProvider({ driver: options.driver, cache: new AnswerCache(options.cacheLifeMs), region: (): string | null => session.region, clusters });
  const region = (): string | null => session.region;
  commands_register(stratusCommands_make({
    clusters, driver: options.driver, region, clustersPath: (): string => `${session.tenancyPath}/clusters`,
    cache: new AnswerCache(CAPACITY_CACHE_LIFE_MS),
    build: { clusters, store, driver: options.driver, region, deps, clustersPath: (): string => `${session.tenancyPath}/clusters`, builder: options.builder ?? null, baseDomain: options.baseDomain ?? null, ...(options.account !== undefined ? { account: options.account } : {}), ...(options.verifyReach !== undefined ? { verifyReach: options.verifyReach } : {}) },
  }), 'backend');
  const dispatcher: VFSDispatcher = new VFSDispatcher();
  dispatcher.provider_register(tenancy);
  const backend: Backend = {
    id: 'stratus',
    session,
    vfs: {
      dispatcher,
      // The tenancy and its fixed folders are entered without asking once
      // the session knows its tenancy (docs/stratus.adoc, D4).
      get structural(): ReadonlyArray<string> {
        return structuralPaths_list(session);
      },
    },
    // One file's bytes for `play` and a surface; the tree is read-only, so a write is refused.
    files: {
      read: async (path: string): Promise<Buffer> => {
        const bytes: VfsOutcome<Buffer> = await dispatcher.readBinary(path);
        if (!bytes.ok) throw new FileReadRefusal(path, bytes.errno === 'ENOENT' ? 404 : 403, bytes.reason ?? bytes.errno);
        return bytes.value;
      },
      write: async (path: string): Promise<void> => {
        throw new Error(`cannot write ${path}: ${READ_ONLY_REASON}`);
      },
    },
    completion: { rootWords: ['net'] },
    // A cluster's build runs as a task; one left running when the daemon stopped goes on from its first step not done.
    jobs: [{
      id: STEPS_SOURCE,
      label: 'build steps',
      resume: (record: JobRecord): JobRun | null => deps === null || typeof record.data['cluster'] !== 'string'
        ? null
        : buildRun_make(record.data['cluster'], typeof record.data['through'] === 'string' ? record.data['through'] : undefined, deps),
    }],
    listingLook: stratusListingLook,
    // What a tenant's manifest can claim about its cluster (`expect cluster …`).
    expectSubjects: [clusterExpectSubject_make({ store, driver: options.driver, now: (): Date => new Date() })],
    prompt: async (last?: PromptLastCommand): Promise<PromptContext> => {
      const cwd: string = session.cwd_get() ?? (await session.home_get());
      return {
        user: (await session.user_get()) ?? 'disconnected',
        uri: session.identity?.tenancy ?? '',
        cwd,
        pacsserver: null,
        physicalMode: false,
        lastExitCode: last?.lastExitCode ?? 0,
        lastCommandDurationMs: last?.lastCommandDurationMs ?? 0,
        segments: stratusSegments_build(session, cwd),
      };
    },
  };
  return { backend, session, tenancy, clusters, store };
}
