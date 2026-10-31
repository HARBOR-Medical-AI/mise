/**
 * @file The stratus prompt: where in the substrate a session stands, as
 * backend-neutral segments (docs/stratus.adoc, D9).
 *
 * The leader names the cloud (`OCI`, or `OCI ✗` when the credential does not
 * work); then the tenancy, the region, the user, the cluster when the working
 * directory is inside one, and the working directory. The user is the cloud's
 * name for the identity in full, an e-mail address on a tenancy that names
 * users so; a surface that is short of room truncates it from the left, as it
 * does a path, so `whoami` and the prompt never disagree.
 *
 * @module
 */
import type { PromptSegment } from '@fnndsc/menu';
import type { StratusSession } from './session.js';

/** The segment keys a stratus prompt uses, in the order they are drawn. */
export const STRATUS_SEGMENT_KEYS = ['cloud', 'tenancy', 'region', 'user', 'cluster', 'cwd'] as const;

/**
 * Names the cluster a path is inside, when it is one.
 *
 * @param cwd - The working directory.
 * @param tenancyPath - The tenancy's folder, `/net/oci/<tenancy>`.
 * @returns The cluster's name, or null when the path is not under `clusters/<name>`.
 */
export function cluster_parse(cwd: string, tenancyPath: string): string | null {
  const prefix: string = `${tenancyPath}/clusters/`;
  if (!cwd.startsWith(prefix)) return null;
  const name: string = cwd.slice(prefix.length).split('/')[0] ?? '';
  return name.length > 0 ? name : null;
}

/**
 * Builds the prompt's segments from the session as it stands.
 *
 * @param session - The stratus session.
 * @param cwd - The working directory the prompt shows.
 * @returns The segments, leader first.
 */
export function stratusSegments_build(session: StratusSession, cwd: string): PromptSegment[] {
  const cloud: string = session.cloudLabel;
  if (session.identity === null) {
    return [
      { key: 'cloud', label: 'cloud', value: `${cloud} ✗`, tone: 'alert' },
      { key: 'cwd', label: 'working directory', value: cwd, tone: 'path' },
    ];
  }
  const segments: PromptSegment[] = [
    { key: 'cloud', label: 'cloud', value: cloud, tone: 'leader' },
    { key: 'tenancy', label: 'tenancy', value: session.identity.tenancy, tone: 'place' },
  ];
  const region: string | null = session.region;
  if (region !== null) segments.push({ key: 'region', label: 'region', value: region, tone: 'place' });
  segments.push({ key: 'user', label: 'user', value: session.identity.user, tone: 'identity' });
  const cluster: string | null = cluster_parse(cwd, session.tenancyPath);
  if (cluster !== null) segments.push({ key: 'cluster', label: 'cluster', value: cluster, tone: 'work' });
  segments.push({ key: 'cwd', label: 'working directory', value: cwd, tone: 'path' });
  return segments;
}
