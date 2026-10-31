/**
 * @file The stratus prompt's segments: where in the substrate a session stands.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PromptSegment } from '@fnndsc/menu';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { StratusSession } from '../src/session.js';
import { cluster_parse, stratusSegments_build, STRATUS_SEGMENT_KEYS } from '../src/prompt.js';

/** A session over the fake cloud, connected, standing at `cwd`. */
async function session_make(cwd?: string): Promise<StratusSession> {
  const session = new StratusSession({ driver: new FakeDriver(fakeCloud_sample()), configDir: mkdtempSync(path.join(tmpdir(), 'stratus-prompt-')) });
  await session.init();
  if (cwd !== undefined) await session.cwd_save(cwd);
  return session;
}

describe('cluster_parse', () => {
  it('names the cluster a path is inside, and nothing else', () => {
    expect(cluster_parse('/net/oci/fnndsc/clusters/harbor/steps', '/net/oci/fnndsc')).toBe('harbor');
    expect(cluster_parse('/net/oci/fnndsc/clusters/harbor', '/net/oci/fnndsc')).toBe('harbor');
    expect(cluster_parse('/net/oci/fnndsc/clusters', '/net/oci/fnndsc')).toBeNull();
    expect(cluster_parse('/net/oci/fnndsc/clusters/', '/net/oci/fnndsc')).toBeNull();
    expect(cluster_parse('/net/oci/fnndsc/harbor-oci', '/net/oci/fnndsc')).toBeNull();
    expect(cluster_parse('/net/oci/other/clusters/harbor', '/net/oci/fnndsc')).toBeNull();
  });
});

describe('stratusSegments_build', () => {
  it('leads with the cloud, then the tenancy, the region, the user in full, and the working directory', async () => {
    const session = await session_make();
    const cwd: string = '/net/oci/fnndsc/clusters';
    const segments: PromptSegment[] = stratusSegments_build(session, cwd);
    expect(segments.map((segment) => segment.key)).toEqual(['cloud', 'tenancy', 'region', 'user', 'cwd']);
    expect(segments[0]).toEqual({ key: 'cloud', label: 'cloud', value: 'OCI', tone: 'leader' });
    expect(segments[1]).toMatchObject({ value: 'fnndsc', tone: 'place' });
    expect(segments[2]).toMatchObject({ value: session.region, tone: 'place' });
    expect(segments[3]).toEqual({ key: 'user', label: 'user', value: 'rudolph', tone: 'identity' });
    expect(segments[4]).toEqual({ key: 'cwd', label: 'working directory', value: cwd, tone: 'path' });
    for (const segment of segments) expect(STRATUS_SEGMENT_KEYS).toContain(segment.key);
  });

  it('adds the cluster when the working directory is inside one', async () => {
    const session = await session_make('/net/oci/fnndsc/clusters/harbor/steps');
    const segments: PromptSegment[] = stratusSegments_build(session, '/net/oci/fnndsc/clusters/harbor/steps');
    expect(segments.map((segment) => segment.key)).toEqual(['cloud', 'tenancy', 'region', 'user', 'cluster', 'cwd']);
    expect(segments[4]).toEqual({ key: 'cluster', label: 'cluster', value: 'harbor', tone: 'work' });
  });

  it('reads OCI ✗ as an alert, with only the working directory beside it, when the credential does not work', async () => {
    const broken = new (class extends FakeDriver {
      override async identity_get(): Promise<never> { throw new Error('no key'); }
    })(fakeCloud_sample());
    const session = new StratusSession({ driver: broken, configDir: mkdtempSync(path.join(tmpdir(), 'stratus-prompt-')) });
    await session.init();
    expect(stratusSegments_build(session, '/net/oci')).toEqual([
      { key: 'cloud', label: 'cloud', value: 'OCI ✗', tone: 'alert' },
      { key: 'cwd', label: 'working directory', value: '/net/oci', tone: 'path' },
    ]);
  });
});
