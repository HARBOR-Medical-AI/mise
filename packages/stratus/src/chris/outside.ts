/**
 * @file How a deploy looks at a ChRIS from outside: the addresses public
 * resolvers give a name (not this host's own resolver, which may cache or
 * see a private view), and the status a URL answers this host with.
 *
 * @module
 */
import { promises as dns } from 'dns';

/** The public resolvers asked. */
const PUBLIC_RESOLVERS: ReadonlyArray<string> = ['1.1.1.1', '8.8.8.8'];

/**
 * The IPv4 addresses public resolvers give a name, from each resolver asked.
 *
 * @param host - The name.
 * @returns The addresses, none when it does not resolve.
 */
export async function publicAddresses_resolve(host: string): Promise<string[]> {
  const found: Set<string> = new Set();
  for (const server of PUBLIC_RESOLVERS) {
    const resolver = new dns.Resolver({ timeout: 5000, tries: 1 });
    resolver.setServers([server]);
    try {
      for (const address of await resolver.resolve4(host)) found.add(address);
    } catch {
      // not resolving there is an answer: none
    }
  }
  return [...found];
}

/**
 * The status a URL answers, redirects not followed.
 *
 * @param url - The URL.
 * @returns The status, or null when nothing answers in fifteen seconds.
 */
export async function urlStatus_get(url: string): Promise<number | null> {
  try {
    return (await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })).status;
  } catch {
    return null;
  }
}

/**
 * A zone's name servers, from the public resolvers.
 *
 * @param zone - The zone.
 * @returns The name servers, none when the zone does not answer.
 */
export async function publicNameservers_get(zone: string): Promise<string[]> {
  for (const server of PUBLIC_RESOLVERS) {
    const resolver = new dns.Resolver({ timeout: 5000, tries: 1 });
    resolver.setServers([server]);
    try {
      return (await resolver.resolveNs(zone)).sort();
    } catch {
      // the next resolver
    }
  }
  return [];
}
