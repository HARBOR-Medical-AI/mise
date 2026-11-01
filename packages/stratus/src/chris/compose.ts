/**
 * @file A ChRIS on a host with Docker (docs/stratus.adoc, D16): the compose
 * file, its two environment files and Caddy's, rendered from a profile, the
 * deploy's secrets and the name it answers to. CUBE runs in production
 * (uvicorn on 8000, migrations as their own run), its broker Dragonfly, and
 * pfcon in-network beside it, starting plugins through the host's Docker on
 * the shared files volume it finds by its own label. Caddy is the one thing
 * on 80 and 443: with a host it obtains the certificate, without one it
 * serves plain HTTP on the address. CUBE also answers on 127.0.0.1:8000 for
 * the deploy's own checks, never outside.
 *
 * Every file lands in `/srv/data/chris/` on the VM, on the data volume, so a
 * rebuilt machine finds them with the database and the files.
 *
 * @module
 */
import * as yaml from 'js-yaml';
import { CHRIS_IMAGES, type ChrisProfile } from './profiles.js';

/** What a deploy keeps secret, generated once and reused by every replay. */
export interface ChrisSecrets {
  djangoKey: string;
  postgresPassword: string;
  pfconSecretKey: string;
  pfconPassword: string;
  /** The `chris` superuser's password. */
  adminPassword: string;
}

/** What a deploy is told. */
export interface ChrisTarget {
  /** The name it answers to (`cube.chrisproject.org`), or null to answer on the address over plain HTTP. */
  readonly host: string | null;
  /** The VM's public address. */
  readonly address: string;
}

/** Where everything lands on the VM. */
export const CHRIS_DIR: string = '/srv/data/chris';

/** The compose project's name: the containers, volumes and network carry it. */
export const CHRIS_PROJECT: string = 'chris';

/** The user pfcon reaches its compute as. */
export const PFCON_USER: string = 'pfcon';

/**
 * The URL CUBE answers on, as clients reach it.
 *
 * @param target - The host or the address.
 * @returns `https://cube.chrisproject.org/api/v1/` or `http://129.153.33.80/api/v1/`.
 */
export function apiUrl_derive(target: ChrisTarget): string {
  return target.host !== null ? `https://${target.host}/api/v1/` : `http://${target.address}/api/v1/`;
}

/**
 * CUBE's environment, production.
 *
 * @param target - The host or the address.
 * @param secrets - The secrets.
 * @returns `cube.env`.
 */
export function cubeEnv_render(target: ChrisTarget, secrets: ChrisSecrets): string {
  const hosts: string[] = target.host !== null ? [target.host, 'localhost', '127.0.0.1', 'chris'] : ['*'];
  const pairs: Array<[string, string]> = [
    ['DJANGO_SETTINGS_MODULE', 'config.settings.production'],
    ['DJANGO_SECRET_KEY', secrets.djangoKey],
    ['DJANGO_ALLOWED_HOSTS', hosts.join(',')],
    ['DJANGO_CORS_ALLOW_ALL_ORIGINS', 'true'],
    ['DJANGO_SECURE_PROXY_SSL_HEADER', target.host !== null ? 'HTTP_X_FORWARDED_PROTO,https' : ''],
    ['DJANGO_USE_X_FORWARDED_HOST', 'true'],
    ['CHRIS_SUPERUSER_PASSWORD', secrets.adminPassword],
    ['CHRIS_STORE_URL', apiUrl_derive(target)],
    ['POSTGRES_DB', 'chris'],
    ['POSTGRES_USER', 'chris'],
    ['POSTGRES_PASSWORD', secrets.postgresPassword],
    ['DATABASE_HOST', 'db'],
    ['DATABASE_PORT', '5432'],
    ['DATABASE_CONN_POOL', 'false'],
    ['STORAGE_ENV', 'fslink'],
    ['MEDIA_ROOT', '/data'],
    ['CELERY_BROKER_URL', 'redis://dragonfly:6379/0'],
    ['NATS_ADDRESS', 'nats:4222'],
    ['PFDCM_ADDRESS', 'http://pfdcm:4005'],
    ['AUTH_LDAP', 'false'],
    ['DISABLE_USER_ACCOUNT_CREATION', 'true'],
  ];
  return `${pairs.map(([key, value]): string => `${key}=${value}`).join('\n')}\n`;
}

/**
 * pfcon's environment: in-network, files linked, plugins on the host's Docker.
 *
 * @param secrets - The secrets.
 * @returns `pfcon.env`.
 */
export function pfconEnv_render(secrets: ChrisSecrets): string {
  const pairs: Array<[string, string]> = [
    ['SECRET_KEY', secrets.pfconSecretKey],
    ['PFCON_USER', PFCON_USER],
    ['PFCON_PASSWORD', secrets.pfconPassword],
    ['PFCON_INNETWORK', 'true'],
    ['STORAGE_ENV', 'fslink'],
    ['STOREBASE_MOUNT', '/var/local/storeBase'],
    ['CONTAINER_ENV', 'docker'],
    ['COMPUTE_VOLUME_TYPE', 'docker_local_volume'],
    ['ENABLE_HOME_WORKAROUND', 'yes'],
    ['REMOVE_JOBS', 'yes'],
    ['JOB_LABELS', 'org.chrisproject.stratus=plugininstance'],
  ];
  return `${pairs.map(([key, value]): string => `${key}=${value}`).join('\n')}\n`;
}

/**
 * Caddy's file: the host with its certificate, or plain HTTP on any address.
 *
 * @param target - The host or the address.
 * @returns `Caddyfile`.
 */
export function caddyfile_render(target: ChrisTarget): string {
  const site: string = target.host !== null ? target.host : ':80';
  return `${site} {\n\treverse_proxy chris:8000\n}\n`;
}

/**
 * The compose file for a profile.
 *
 * @param profile - The profile.
 * @returns `compose.yml`.
 */
export function compose_render(profile: ChrisProfile): string {
  const cube = (command: string[] | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    image: CHRIS_IMAGES.cube,
    ...(command !== null ? { command } : {}),
    env_file: ['cube.env'],
    volumes: ['files:/data'],
    restart: 'unless-stopped',
    depends_on: { migrate: { condition: 'service_completed_successfully' }, dragonfly: { condition: 'service_started' }, nats: { condition: 'service_started' } },
    ...extra,
  });
  const all: Record<string, unknown> = {
    db: {
      image: CHRIS_IMAGES.postgres,
      env_file: ['cube.env'],
      environment: { POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256' },
      volumes: ['db:/var/lib/postgresql/data'],
      restart: 'unless-stopped',
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U chris -d chris'], interval: '5s', timeout: '4s', retries: 10, start_period: '60s' },
    },
    dragonfly: { image: CHRIS_IMAGES.dragonfly, restart: 'unless-stopped', ulimits: { memlock: -1 } },
    nats: { image: CHRIS_IMAGES.nats, restart: 'unless-stopped' },
    'files-fix': { image: CHRIS_IMAGES.alpine, user: 'root', command: ['chmod', 'g+rwx', '/data'], volumes: ['files:/data'], restart: 'no' },
    migrate: {
      image: CHRIS_IMAGES.cube,
      command: ['python', 'manage.py', 'migrate', '--noinput'],
      env_file: ['cube.env'],
      volumes: ['files:/data'],
      restart: 'no',
      depends_on: { db: { condition: 'service_healthy' }, 'files-fix': { condition: 'service_completed_successfully' } },
    },
    chris: cube(null, { ports: ['127.0.0.1:8000:8000'] }),
    worker: cube(['celery', '-A', 'core', 'worker', '-c', '4', '-l', 'info', '-Q', 'main1,main2'], { depends_on: { migrate: { condition: 'service_completed_successfully' }, dragonfly: { condition: 'service_started' }, nats: { condition: 'service_started' }, pfcon: { condition: 'service_started' } } }),
    'worker-periodic': cube(['celery', '-A', 'core', 'worker', '-c', '2', '-l', 'info', '-Q', 'periodic']),
    scheduler: cube(['celery', '-A', 'core', 'beat', '-l', 'info', '--scheduler', 'django_celery_beat.schedulers:DatabaseScheduler']),
    pfcon: {
      image: CHRIS_IMAGES.pfcon,
      env_file: ['pfcon.env'],
      volumes: ['files:/var/local/storeBase', '/var/run/docker.sock:/var/run/docker.sock'],
      labels: { 'org.chrisproject.role': 'pfcon' },
      userns_mode: 'host',
      restart: 'unless-stopped',
      depends_on: { 'files-fix': { condition: 'service_completed_successfully' } },
    },
    caddy: {
      image: CHRIS_IMAGES.caddy,
      ports: ['80:80', '443:443'],
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config'],
      restart: 'unless-stopped',
      depends_on: { chris: { condition: 'service_started' } },
    },
  };
  const services: Record<string, unknown> = Object.fromEntries(profile.services.map((name: string): [string, unknown] => {
    const service: unknown = all[name];
    if (service === undefined) throw new Error(`the profile ${profile.name} names ${name}, which no service is`);
    return [name, service];
  }));
  return `# ChRIS, profile ${profile.name}: written by stratus's chris deploy; replay the script to change it.\n${yaml.dump({ name: CHRIS_PROJECT, services, volumes: { files: null, db: null, 'caddy-data': null, 'caddy-config': null } }, { lineWidth: -1, noRefs: true })}`;
}
