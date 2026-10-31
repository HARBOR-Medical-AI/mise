/**
 * @file The stratus command line refuses unknown words by name.
 */
import { describe, it, expect } from '@jest/globals';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clusterArg_parse, stratusArgs_parse } from '../src/args.js';

describe('stratusArgs_parse', () => {
  it('takes the profile, config, region, fake and help, in both flag forms', () => {
    expect(stratusArgs_parse([])).toEqual({ args: { profile: undefined, configFile: undefined, region: undefined, fake: false, help: false, clusters: [] } });
    expect(stratusArgs_parse(['--profile', 'BCH', '--region=us-phoenix-1', '--config', '/x/config', '--fake', '-h'])).toEqual({
      args: { profile: 'BCH', configFile: '/x/config', region: 'us-phoenix-1', fake: true, help: true, clusters: [] },
    });
    expect(stratusArgs_parse(['--host-control', '--expose-host-control', '--help'])).toMatchObject({ args: { help: true } });
    expect(stratusArgs_parse(['--host-control=shell,files'])).toMatchObject({ args: { fake: false } });
    expect(stratusArgs_parse(['--host-control', 'tasks', '--fake'])).toMatchObject({ args: { fake: true } });
    expect(stratusArgs_parse(['--host-control', '--fake'])).toMatchObject({ args: { fake: true } });
  });

  it('refuses an unknown word by name', () => {
    expect(stratusArgs_parse(['--tenancy', 'x'])).toEqual({ error: "unknown option '--tenancy' (stratus --help)" });
    expect(stratusArgs_parse(['--region=us-ashburn-1', '--bogus=1'])).toEqual({ error: "unknown option '--bogus=1' (stratus --help)" });
  });

  it('takes --cluster as many times as given, in both forms, ~ as home', () => {
    expect(stratusArgs_parse(['--cluster', 'harbor=~/src/harbor-oci', '--cluster=lab=/srv/lab', '--fake'])).toMatchObject({
      args: { fake: true, clusters: [{ name: 'harbor', root: join(homedir(), 'src/harbor-oci') }, { name: 'lab', root: '/srv/lab' }] },
    });
    expect(clusterArg_parse('home=~')).toEqual({ name: 'home', root: homedir() });
    expect(clusterArg_parse('rel=checkout')).toEqual({ name: 'rel', root: resolve('checkout') });
  });

  it('refuses a --cluster that is not <name>=<checkout>', () => {
    for (const bad of ['harbor', '=x', 'harbor=', 'a/b=x', '.hidden=x']) expect(clusterArg_parse(bad)).toBeNull();
    expect(stratusArgs_parse(['--cluster', 'harbor'])).toEqual({ error: "--cluster takes <name>=<harbor-oci checkout>, not 'harbor'" });
    expect(stratusArgs_parse(['--cluster'])).toEqual({ error: "--cluster takes <name>=<harbor-oci checkout>, not ''" });
    expect(stratusArgs_parse(['--cluster=x'])).toEqual({ error: "--cluster takes <name>=<harbor-oci checkout>, not 'x'" });
  });
});
