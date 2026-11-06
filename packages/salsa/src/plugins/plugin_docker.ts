/**
 * @file Reading a plugin's descriptor out of its container image.
 *
 * The last way `plugin add` finds a descriptor: pull the image (or use the
 * local copy) and ask it, trying the three ways ChRIS plugins have printed
 * one over the years, in chrisomatic's order — `chris_plugin_info` with the
 * image named, `chris_plugin_info` bare, and the old chrisapp `<CMD> --json`.
 *
 * Every docker call is an argument vector run without a shell: an image
 * reference is operator input and never reaches a command line as text.
 *
 * Key components:
 * - DockerRun: the seam that runs one docker command (tests stub it).
 * - docker_isAvailable: whether a docker daemon answers.
 * - dockerImage_ensure: the image locally, pulled when absent.
 * - descriptorFromImage_extract: the image's descriptor JSON, by the three ways.
 *
 * Typical usage:
 * ```ts
 * if (await docker_isAvailable() && await dockerImage_ensure(image)) {
 *   const descriptor: Record<string, unknown> | null = await descriptorFromImage_extract(image);
 * }
 * ```
 *
 * Dependencies: Node.js `child_process`; a `docker` CLI on the host.
 *
 * @module
 */

import { execFile } from 'node:child_process';

/** What one docker command answered. */
export interface DockerAnswer {
  /** True when the command exited zero. */
  readonly ok: boolean;
  /** Its standard output, trimmed. */
  readonly stdout: string;
  /** Its standard error or failure message, trimmed. */
  readonly stderr: string;
}

/** Runs one docker command from its argument vector. */
export type DockerRun = (args: readonly string[]) => Promise<DockerAnswer>;

/** Longest a descriptor print may take: some images (TensorFlow, MINC) take minutes. */
const DESCRIPTOR_TIMEOUT_MS: number = 10 * 60 * 1000;

/** Largest output read from a docker command. */
const OUTPUT_MAX_BYTES: number = 32 * 1024 * 1024;

/**
 * Runs `docker` with an argument vector, no shell.
 *
 * @param args - The arguments after `docker`.
 * @returns What it answered; never throws.
 *
 * @example
 * ```ts
 * const answer: DockerAnswer = await docker_run(['image', 'inspect', 'alpine']);
 * ```
 */
export const docker_run: DockerRun = (args: readonly string[]): Promise<DockerAnswer> =>
  new Promise<DockerAnswer>((resolve: (answer: DockerAnswer) => void): void => {
    execFile('docker', [...args], { timeout: DESCRIPTOR_TIMEOUT_MS, maxBuffer: OUTPUT_MAX_BYTES },
      (error: Error | null, stdout: string, stderr: string): void => {
        resolve({ ok: error === null, stdout: String(stdout).trim(), stderr: String(stderr || error?.message || '').trim() });
      });
  });

/**
 * Reports whether a docker daemon answers.
 *
 * @param run - The docker seam.
 * @returns True when `docker info` succeeds.
 *
 * @example
 * ```ts
 * await docker_isAvailable(); // false on a host without docker
 * ```
 */
export async function docker_isAvailable(run: DockerRun = docker_run): Promise<boolean> {
  return (await run(['info', '--format', '{{.ServerVersion}}'])).ok;
}

/**
 * Makes sure an image is present locally, pulling it when it is not.
 *
 * @param image - The image reference.
 * @param run - The docker seam.
 * @returns Null when the image is present; else why it could not be had.
 *
 * @example
 * ```ts
 * await dockerImage_ensure('fnndsc/pl-dircopy:2.1.1'); // null
 * ```
 */
export async function dockerImage_ensure(image: string, run: DockerRun = docker_run): Promise<string | null> {
  if ((await run(['image', 'inspect', '--format', '{{.Id}}', image])).ok) return null;
  const pulled: DockerAnswer = await run(['pull', '--quiet', image]);
  return pulled.ok ? null : `docker pull ${image} failed: ${pulled.stderr || 'no reason given'}`;
}

/**
 * Reads a plugin's descriptor out of its image.
 *
 * @param image - The image reference.
 * @param publicRepo - The plugin's repository, passed to `chris_plugin_info` when known.
 * @param run - The docker seam.
 * @returns The descriptor, or null when none of the three ways printed one.
 *
 * @example
 * ```ts
 * const descriptor: Record<string, unknown> | null = await descriptorFromImage_extract('fnndsc/pl-dircopy:2.1.1');
 * ```
 */
export async function descriptorFromImage_extract(
  image: string,
  publicRepo?: string,
  run: DockerRun = docker_run,
): Promise<Record<string, unknown> | null> {
  const withArgs: string[] = ['run', '--rm', image, 'chris_plugin_info', '--dock-image', image];
  if (publicRepo !== undefined) withArgs.push('--public-repo', publicRepo);
  const attempts: Array<() => Promise<DockerAnswer | null>> = [
    (): Promise<DockerAnswer> => run(withArgs),
    (): Promise<DockerAnswer> => run(['run', '--rm', image, 'chris_plugin_info']),
    async (): Promise<DockerAnswer | null> => {
      const command: string | null = await imageCommand_get(image, run);
      return command === null ? null : run(['run', '--rm', image, command, '--json']);
    },
  ];
  for (const attempt of attempts) {
    const answer: DockerAnswer | null = await attempt();
    if (answer === null || !answer.ok || answer.stdout === '') continue;
    const parsed: Record<string, unknown> | null = descriptorJson_parse(answer.stdout);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Reads an image's default command, for the old chrisapp `--json` way.
 *
 * @param image - The image reference.
 * @param run - The docker seam.
 * @returns The first word of the image's CMD, or null when it has none.
 */
async function imageCommand_get(image: string, run: DockerRun): Promise<string | null> {
  const answer: DockerAnswer = await run(['image', 'inspect', '--format', '{{json .Config.Cmd}}', image]);
  if (!answer.ok) return null;
  try {
    const command: unknown = JSON.parse(answer.stdout) as unknown;
    return Array.isArray(command) && typeof command[0] === 'string' ? command[0] : null;
  } catch {
    return null;
  }
}

/**
 * Parses a printed descriptor.
 *
 * @param text - What the image printed.
 * @returns The descriptor object, or null when the text is not one.
 */
function descriptorJson_parse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
