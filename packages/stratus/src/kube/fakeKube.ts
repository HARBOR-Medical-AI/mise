/**
 * @file A fake cluster answering the Kubernetes API calls `verify` makes, a
 * healthy one unless told otherwise, and the fake world's DNS and HTTPS
 * around it. What `stratus --fake` verifies against, and the tests.
 *
 * @module
 */
import type { KubeApi } from './kube.js';
import { KubeError } from './kube.js';
import type { VerifyReach } from '../commands/verify.js';
import { TEST_PASSWORD_FILE, type ChrisCall, type ChrisWork } from './chris.js';

/** One fake node. */
export interface FakeNode {
  readonly name: string;
  readonly zone: string;
  readonly shape: string;
}

/** How the fake cluster answers. */
export interface FakeClusterOptions {
  readonly nodes: ReadonlyArray<FakeNode>;
  /** Operators that are not settled. */
  readonly degraded?: ReadonlyArray<string>;
  /** Whether the volume probe's pod succeeds. */
  readonly probeSucceeds?: boolean;
}

/** A fake cluster, keeping what the volume probe makes. */
export class FakeKube implements KubeApi {
  readonly made: string[] = [];
  readonly deleted: string[] = [];
  private readonly namespaces: Set<string> = new Set();

  constructor(private readonly options: FakeClusterOptions) {}

  async json_get(path: string): Promise<unknown> {
    if (path === '/apis/config.openshift.io/v1/clusterversions/version') {
      return { status: { desired: { version: '4.22.3' }, conditions: [{ type: 'Available', status: 'True' }, { type: 'Failing', status: 'False' }] } };
    }
    if (path === '/api/v1/nodes') {
      return {
        items: this.options.nodes.map((node: FakeNode) => ({
          metadata: { name: node.name, labels: { 'node.kubernetes.io/instance-type': node.shape, 'topology.kubernetes.io/zone': node.zone } },
          spec: { providerID: `oci://ocid1.instance.${node.name}` },
          status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '7500m' } },
        })),
      };
    }
    if (path === '/apis/config.openshift.io/v1/clusteroperators') {
      const names: string[] = ['console', 'dns', 'ingress', 'storage', ...(this.options.degraded ?? [])];
      return {
        items: names.map((name: string) => ({
          metadata: { name },
          status: { conditions: (this.options.degraded ?? []).includes(name)
            ? [{ type: 'Available', status: 'True' }, { type: 'Progressing', status: 'False' }, { type: 'Degraded', status: 'True' }]
            : [{ type: 'Available', status: 'True' }, { type: 'Progressing', status: 'False' }, { type: 'Degraded', status: 'False' }] },
        })),
      };
    }
    if (path === '/apis/storage.k8s.io/v1/storageclasses') {
      return { items: [{ metadata: { name: 'oci-bv', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } }, { metadata: { name: 'oci-bv-encrypted' } }] };
    }
    if (path === '/api/v1/pods') {
      return { items: this.options.nodes.map((node: FakeNode) => ({ spec: { nodeName: node.name, containers: [{ resources: { requests: { cpu: '3' } } }] }, status: { phase: 'Running' } })) };
    }
    if (path === '/api/v1/namespaces/openshift-ingress-operator/secrets/router-ca') {
      return { data: { 'tls.crt': Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n').toString('base64') } };
    }
    const pod: RegExpMatchArray | null = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/probe$/.exec(path);
    if (pod !== null && this.namespaces.has(pod[1] as string)) return { status: { phase: this.options.probeSucceeds === false ? 'Failed' : 'Succeeded' } };
    throw new KubeError(404, `GET ${path}: HTTP 404 not found`);
  }

  async text_get(path: string): Promise<string> {
    if (path === '/readyz') return 'ok';
    if (/\/pods\/probe\/log$/.test(path)) return 'stratus\n';
    throw new KubeError(404, `GET ${path}: HTTP 404 not found`);
  }

  async json_post(path: string, body: unknown): Promise<unknown> {
    this.made.push(path);
    if (path === '/api/v1/namespaces') this.namespaces.add((body as { metadata: { name: string } }).metadata.name);
    return body;
  }

  async delete(path: string): Promise<void> {
    const ns: RegExpMatchArray | null = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path);
    if (ns === null || !this.namespaces.has(ns[1] as string)) throw new KubeError(404, `DELETE ${path}: HTTP 404 not found`);
    this.namespaces.delete(ns[1] as string);
    this.deleted.push(path);
  }
}

/**
 * The fake world's reach for `verify`: a healthy cluster of the given nodes,
 * the fake build's load-balancer addresses in DNS, a console that answers.
 *
 * @param nodes_of - The nodes of a cluster, from its kubeconfig's text.
 * @returns The reach.
 */
export function fakeVerifyReach(nodes_of: (kubeconfig: string) => FakeNode[]): VerifyReach {
  return {
    kube_make: (kubeconfig: string): KubeApi => new FakeKube({ nodes: nodes_of(kubeconfig) }),
    resolve: async (name: string): Promise<string[]> => [name.startsWith('api-int.') ? '10.0.0.11' : name.startsWith('api.') ? '10.0.0.10' : '10.0.0.12'],
    https_status: async (): Promise<number> => 200,
    probeTimeoutMs: 1000,
    pollMs: 0,
  };
}

/**
 * ChRIS in the fake world: each step says what the real one would have done
 * and keeps what the next reads, so a fake build runs through `smoke`.
 */
export const fakeChrisWork: ChrisWork = {
  async deploy(call: ChrisCall): Promise<string> {
    call.log(`release ${call.release.release}: fnndsc/chris ${call.release.chartVersion} (fake)`);
    return `fnndsc/chris ${call.release.chartVersion} at https://${call.cubeHost}/api/v1/ (fake)`;
  },
  async seed(call: ChrisCall): Promise<string> {
    if (call.secret_read(TEST_PASSWORD_FILE) === null) call.secret_write(TEST_PASSWORD_FILE, 'fake\n');
    return `test user ${call.release.testUser} (fake)`;
  },
  async smoke(call: ChrisCall): Promise<string> {
    if (call.secret_read(TEST_PASSWORD_FILE) === null) throw new Error('no test user yet: chris-seed has not been done');
    return `the smoke journey passes as ${call.release.testUser} (fake)`;
  },
};
