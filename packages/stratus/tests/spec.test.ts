/**
 * @file A cluster's spec: written and read in harbor-oci's shape, sized from
 * `cluster new`'s options, and placed one node per zone.
 */
import { describe, it, expect } from '@jest/globals';
import { poolArg_parse, SPEC_DEFAULT, specNodes_build, specOptions_apply, specYaml_parse, specYaml_render, type ClusterSpec } from '../src/cluster/spec.js';

describe('the spec', () => {
  it('writes harbor-oci\'s shape and reads it back', () => {
    const text: string = specYaml_render(SPEC_DEFAULT);
    expect(text).toContain('family: E5');
    expect(text).toContain('controlPlane:\n  count: 3');
    expect(text).toContain('# 0: compact cluster');
    const read = specYaml_parse(text);
    expect(read).toEqual({ spec: SPEC_DEFAULT });
  });

  it('reads harbor-oci\'s own spec.yaml, comments and all', () => {
    const text: string = [
      '# harbor-oci deployment spec', '', 'family: E5                # CPU family', '', 'controlPlane:', '  count: 3', '  vcpu: 8', '  ramGib: 24', '  bootGib: 200', '  bootTier: ultra         # etcd latency',
      '', 'workers:', '  count: 2', '  vcpu: 16', '  ramGib: 64', '  bootGib: 120', '  bootTier: balanced', '', 'chris:', '  dataGib: 100', '  databaseGib: 5', '  queueGib: 1',
    ].join('\n');
    const read = specYaml_parse(text) as { spec: ClusterSpec };
    expect(read.spec.workers).toEqual({ count: 2, vcpu: 16, ramGib: 64, bootGib: 120, bootTier: 'balanced' });
    expect(read.spec.chris.dataGib).toBe(100);
  });

  it('refuses a line it cannot read, by its number', () => {
    expect(specYaml_parse('family: E5\nflavour: mint\n')).toEqual({ error: 'line 2: flavour: not a spec field' });
    expect(specYaml_parse('controlPlane:\n  colour: red\n')).toEqual({ error: 'line 2: colour: not a field of controlPlane' });
    expect(specYaml_parse('workers:\n  count: many\n')).toEqual({ error: "line 2: count: wants a whole number, not 'many'" });
    expect(specYaml_parse('- a list\n')).toEqual({ error: 'line 1: not a key: value line' });
    expect(specYaml_parse('  vcpu: 3\n')).toEqual({ error: 'line 1: vcpu: not a field of the spec' });
  });

  it('sizes from cluster new\'s options', () => {
    expect(poolArg_parse('2x8/32')).toEqual({ count: 2, vcpu: 8, ramGib: 32 });
    expect(poolArg_parse('two')).toBeNull();
    const sized = specOptions_apply(SPEC_DEFAULT, new Map([['--family', 'A2'], ['--workers', '2x16/64'], ['--plane', '3x4/16'], ['--data', '100'], ['--database', '10'], ['--queue', '2']])) as { spec: ClusterSpec };
    expect(sized.spec).toMatchObject({ family: 'A2', workers: { count: 2, vcpu: 16, ramGib: 64 }, controlPlane: { count: 3, vcpu: 4, ramGib: 16 }, chris: { dataGib: 100, databaseGib: 10, queueGib: 2 } });
    expect(SPEC_DEFAULT.workers.count).toBe(0);
    expect(specOptions_apply(SPEC_DEFAULT, new Map([['--plane', '1x8/24']]))).toEqual({ error: '--plane: the control plane is three nodes, one per availability domain' });
    expect(specOptions_apply(SPEC_DEFAULT, new Map([['--workers', 'lots']]))).toEqual({ error: "--workers takes <count>x<vCPU>/<GiB>, as 3x8/24, not 'lots'" });
    expect(specOptions_apply(SPEC_DEFAULT, new Map([['--data', '-1']]))).toEqual({ error: "--data wants a whole number of GiB, not '-1'" });
    expect(specOptions_apply(SPEC_DEFAULT, new Map([['--colour', 'red']]))).toEqual({ error: '--colour: unknown option' });
  });

  it('places the nodes one per zone in turn', () => {
    const spec: ClusterSpec = (specOptions_apply(SPEC_DEFAULT, new Map([['--workers', '2x8/32']])) as { spec: ClusterSpec }).spec;
    expect(specNodes_build('trial', spec, 3).map((node) => `${node.name}@${node.zoneIndex}`)).toEqual(['trial-cp-0@0', 'trial-cp-1@1', 'trial-cp-2@2', 'trial-w-0@0', 'trial-w-1@1']);
    expect(specNodes_build('one', SPEC_DEFAULT, 0).every((node) => node.zoneIndex === 0)).toBe(true);
  });
});
