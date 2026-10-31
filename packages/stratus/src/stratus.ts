#!/usr/bin/env node
/**
 * @file The `stratus` command: hosts a substrate session as a calypso daemon.
 *
 * stratus ships its own launcher (docs/stratus.adoc, D2): it composes the
 * engine with the stratus backend over the OCI driver and hands it to
 * calypso's `daemon_launch`; calypso itself knows nothing of stratus. The
 * daemon runs on the bastion, the host that holds the cloud credential.
 *
 * Usage:
 *   stratus [--profile NAME] [--config FILE] [--region REGION]
 *           [--host-control[=TIERS]] [--expose-host-control]
 *   stratus --fake            a session over the fake cloud, for tests
 *
 * @module
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engine_create, type BrasaEngine } from '@fnndsc/brasa/core';
import { daemon_launch, daemonConsole_run, hostControl_parseArgv, packageWebRoot_find, type DaemonLaunchInfo, type HostControlPolicy } from '@fnndsc/calypso';
import { fileAccount_make } from './installer/account.js';
import { stratusBackend_make, type StratusBackend, type StratusBackendOptions } from './backend.js';
import type { CloudDriver } from './cloud/driver.js';
import { FakeDriver, fakeCloud_sample } from './cloud/fake/driver.js';
import { OciDriver } from './cloud/oci/driver.js';
import { ociApi_make } from './cloud/oci/api.js';
import { stratusArgs_parse, type StratusArgs } from './args.js';
import { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from './cloud/fake/builder.js';
import { OciBuilder } from './cloud/oci/builder.js';
import { ociBuildApi_make } from './cloud/oci/buildApi.js';
import { AssistedInstaller, serviceAccount_read } from './installer/assisted.js';
import { promises as dnsPromises } from 'node:dns';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fakeChrisWork, fakeVerifyReach } from './kube/fakeKube.js';
import { rmApi_make } from './cloud/oci/rmApi.js';

const USAGE: string = [
  'stratus: a mise session over the cloud substrate a Trusted Domain runs on.',
  '',
  'Usage: stratus [--profile NAME] [--config FILE] [--region REGION]',
  '               [--cluster NAME=CHECKOUT]… [--redhat-account FILE] [--ssh-key FILE]',
  '               [--host-control[=shell,files,pipes,tasks]] [--expose-host-control]',
  '       stratus --fake',
  '',
  '  --profile NAME   the ~/.oci/config profile (DEFAULT)',
  '  --config FILE    the OCI configuration file (~/.oci/config)',
  '  --region REGION  the region the session works in (the profile\'s)',
  '  --cluster NAME=CHECKOUT',
  '                   a cluster built by the harbor-oci checkout at CHECKOUT,',
  '                   shown under ~ (clusters/NAME); repeat for each',
  '  --host-control=tasks',
  '                   let the session start jobs that change the cloud and bill;',
  '                   never granted by a bare --host-control',
  '  --redhat-account FILE',
  '                   the Red Hat service account the builds use (~/.config/ocm/service-account.env)',
  '  --ssh-key FILE   the public key the nodes take (~/.ssh/id_ed25519.pub)',
  '  --fake           host a session over the fake cloud, for tests',
].join('\n');

/**
 * A path with a leading `~` made absolute.
 *
 * @param file - The path.
 * @returns It, from the home folder.
 */
function home_expand(file: string): string {
  return file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
}

/**
 * OCI's build parts: Resource Manager, the build's other calls, the
 * installer, and the files they read on this host, as `harbor-oci` kept them.
 *
 * @param driver - The read driver.
 * @param args - The launch's arguments.
 * @returns The builder and installer.
 */
function oci_buildParts(driver: CloudDriver, args: StratusArgs): Pick<StratusBackendOptions, 'builder' | 'installer' | 'account'> {
  const sshKeyFile: string = home_expand(args.sshKey ?? '~/.ssh/id_ed25519.pub');
  const accountFile: string = home_expand(args.redhatAccount ?? '~/.config/ocm/service-account.env');
  const sshPublicKey = (): string | null => (existsSync(sshKeyFile) ? readFileSync(sshKeyFile, 'utf-8') : null);
  const resolver: dnsPromises.Resolver = new dnsPromises.Resolver();
  resolver.setServers(['8.8.8.8']);
  return {
    builder: new OciBuilder({
      rm: (region: string) => rmApi_make({ configFile: args.configFile, profile: args.profile, region }),
      api: (region: string) => ociBuildApi_make({ configFile: args.configFile, profile: args.profile, region }),
      driver,
      sshPublicKey,
      nameservers_resolve: (zone: string): Promise<string[]> => resolver.resolveNs(zone),
    }),
    account: fileAccount_make(accountFile),
    installer: new AssistedInstaller({
      account: () => serviceAccount_read(readFileSync(accountFile, 'utf-8')),
      sshPublicKey: (): string => { const key: string | null = sshPublicKey(); if (key === null) throw new Error(`${sshKeyFile}: no SSH public key`); return key; },
    }),
  };
}

/**
 * Hosts the daemon.
 */
async function stratus_start(): Promise<void> {
  const parsed = stratusArgs_parse(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[!] ${parsed.error}`);
    process.exit(1);
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return;
  }
  const driver: CloudDriver = parsed.args.fake
    ? new FakeDriver(fakeCloud_sample())
    : new OciDriver({ api: ociApi_make({ configFile: parsed.args.configFile, profile: parsed.args.profile }) });
  // The fake cloud builds over a fake installer on a clock, so a build is seen moving; a real cloud's build half is not written yet.
  const tickMs: number = Number(process.env['STRATUS_FAKE_TICK_MS'] ?? 700);
  const world: FakeBuildWorld = new FakeBuildWorld(tickMs);
  const made: StratusBackend = stratusBackend_make({
    driver,
    region: parsed.args.region,
    clusters: parsed.args.clusters,
    ...(parsed.args.fake
      ? {
        builder: new FakeCloudBuilder(world), installer: new FakeInstaller(world), baseDomain: 'fake.example', waits: { pollMs: tickMs, hostsWaitMs: tickMs * 60, installWaitMs: tickMs * 120, verifyWaitMs: tickMs * 30, chrisWaits: { pollMs: 0, mirrorReactMs: 0, mirrorWaitMs: 0, rolloutWaitMs: 0, seedWaitMs: 0 } },
        chris: fakeChrisWork,
        // The fake cluster a fake build made answers verify: its hosts, healthy.
        verifyReach: fakeVerifyReach((kubeconfig: string) => world.hosts_now(/cluster-([a-z0-9-]+)/.exec(kubeconfig)?.[1] ?? '').map((host) => ({ name: host.name, zone: host.zone, shape: 'VM.Standard.E5.Flex' }))),
      }
      // OCI builds through Resource Manager and Red Hat's Assisted Installer; the credentials stay files on this host.
      : oci_buildParts(driver, parsed.args)),
  });
  const engine: BrasaEngine = await engine_create(made.backend);
  if (made.session.identity === null) {
    console.error(`[!] Not connected to ${driver.cloud}: ${made.session.disconnectedReason ?? 'no credential'}; hosting offline.`);
  } else {
    console.error(`[+] ${made.session.identity.user}@${made.session.identity.tenancy} on ${driver.cloud}, region ${made.session.region}.`);
  }

  const parsedPolicy = hostControl_parseArgv(process.argv, process.env);
  if ('error' in parsedPolicy) {
    console.error(`[!] ${parsedPolicy.error}`);
    process.exit(1);
  }
  const policy: HostControlPolicy = parsedPolicy.policy;
  const info: DaemonLaunchInfo = await daemon_launch(engine, undefined, {
    hostControl: policy,
    webRoot: packageWebRoot_find('@fnndsc/argus'),
  });
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    await daemonConsole_run({ identity: info.identity, url: info.url, token: info.token });
  }
}

const currentFile: string = fileURLToPath(import.meta.url);
let isMain: boolean = false;
try {
  isMain = realpathSync(process.argv[1]) === realpathSync(currentFile);
} catch {
  // Not invoked as a script.
}

if (isMain) {
  stratus_start().catch((error: unknown): void => {
    console.error(`[!] stratus: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
