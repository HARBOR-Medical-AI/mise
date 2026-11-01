/**
 * @file The mise bastion's public address: the one address a network's
 * managed bastion admits (docs/stratus.adoc, D16). Read at build time, never
 * typed, so a script names no address: the host that runs `net build` asks
 * an address echo, the way the store's hand run read it.
 *
 * @module
 */

/** Where the address is asked: Amazon's echo, which answers the caller's address and nothing else. */
export const ADDRESS_ECHO: string = 'https://checkip.amazonaws.com';

/** An IPv4 address. */
const IPV4: RegExp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Reads an echo's answer as an address.
 *
 * @param text - What the echo said.
 * @returns The address as a /32.
 * @throws Error - When it is not an IPv4 address.
 */
export function echoAnswer_read(text: string): string {
  const address: string = text.trim();
  const match: RegExpMatchArray | null = IPV4.exec(address);
  if (match === null || match.slice(1).some((octet: string): boolean => Number(octet) > 255)) throw new Error(`${ADDRESS_ECHO} answered ${JSON.stringify(address.slice(0, 40))}, not an address`);
  return `${address}/32`;
}

/**
 * This host's public address, asked of the echo.
 *
 * @param fetcher - The fetch to ask with; the global one when absent.
 * @returns The address as a /32.
 * @throws Error - When the echo does not answer in ten seconds, or answers no address.
 */
export async function clientCidr_read(fetcher: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(ADDRESS_ECHO, { signal: AbortSignal.timeout(10_000) });
  } catch (error: unknown) {
    throw new Error(`this host's public address: ${ADDRESS_ECHO} did not answer (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) throw new Error(`this host's public address: ${ADDRESS_ECHO} answered ${response.status}`);
  return echoAnswer_read(await response.text());
}
