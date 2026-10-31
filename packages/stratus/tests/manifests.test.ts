/**
 * @file The manifests stratus ships: `tenant.mise` read from the package,
 * shown in the home beside the clusters, and readable as a file there, so
 * `play ~/tenant.mise` finds it.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VFSItem } from '@fnndsc/fond';
import { shippedManifests_read, TENANT_MANIFEST, type ShippedManifest } from '../src/cluster/manifests.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import type { ResourceNode } from '../src/vfs/resources.js';
import { BUILD_STEPS } from '../src/cluster/steps.js';

describe('the manifests stratus ships', () => {
  it('reads tenant.mise from the package: one parameter, the procedure, and what it answers', () => {
    const shipped: ShippedManifest[] = shippedManifests_read();
    expect(shipped.map((manifest: ShippedManifest): string => manifest.name)).toEqual([TENANT_MANIFEST]);
    const text: string = shipped[0]?.text ?? '';
    const directives: string[] = text.split('\n').filter((line: string): boolean => line.startsWith('@'));
    expect(directives.filter((line: string): boolean => line.startsWith('@param')).map((line: string): string => line.split(/\s+/)[1] ?? '')).toEqual(['NAME']);
    expect(directives).toContain('@answers      TENANT');
    const lines: string[] = text.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '' && !line.startsWith('#') && !line.startsWith('@'));
    // The size is the spec's: the procedure never writes one.
    expect(lines.some((line: string): boolean => line.startsWith('cluster new'))).toBe(false);
    expect(lines).toContain('cluster build ${NAME}');
    expect(lines.at(-1)).toBe('TENANT=$(cluster ${NAME})');
    // Every claim is one the cluster subject reads, of a step the build has.
    for (const claim of lines.filter((line: string): boolean => line.startsWith('expect '))) {
      const [, subject, target, property, ...rest] = claim.split(/\s+/);
      expect([subject, target]).toEqual(['cluster', '${NAME}']);
      expect(['step', 'verify', 'class', 'cost']).toContain(property);
      if (property === 'step') expect(BUILD_STEPS).toContain(rest[0]);
    }
  });

  it('leaves out a manifest it cannot read', () => {
    const folder: string = mkdtempSync(join(tmpdir(), 'stratus-manifests-'));
    try {
      expect(shippedManifests_read(pathToFileURL(`${folder}/`))).toEqual([]);
      writeFileSync(join(folder, TENANT_MANIFEST), '@param NAME\n');
      expect(shippedManifests_read(pathToFileURL(`${folder}/`))).toEqual([{ name: TENANT_MANIFEST, text: '@param NAME\n' }]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('shows a manifest in the home beside the clusters, as a file to read', async () => {
    const tree: ClusterTree = new ClusterTree({ sources: [], owner: (): string => 'rudolph', now: (): Date => new Date('2026-10-23T12:00:00Z'), manifests: [{ name: TENANT_MANIFEST, text: '@param NAME\n' }] });
    const home: ResourceNode = tree.node_resolve([]);
    expect(home.kind).toBe('listing');
    const items: VFSItem[] = home.kind === 'listing' ? await home.list() : [];
    expect(items.map((item: VFSItem): string => `${item.name} ${item.type} ${item.size}`)).toEqual(['tenant.mise file 12']);
    expect(tree.node_resolve([TENANT_MANIFEST])).toEqual({ kind: 'file', text: '@param NAME\n' });
    expect(tree.node_resolve([TENANT_MANIFEST, 'x']).kind).toBe('missing');
    expect(tree.node_resolve(['quay']).kind).toBe('missing');
  });
});
