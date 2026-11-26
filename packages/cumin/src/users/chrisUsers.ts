/**
 * @file ChRIS user identity resource access.
 *
 * @module
 */

import { chrisConnection } from '../connect/chrisConnection.js';
import {
  client_adminRequest,
  client_adminUrlEnsure,
  listData_get,
  itemData_get,
  type Client,
  type User,
  type UserGroupList,
  shape_build,
  type Shape,
} from '../chrisapi/adapter.js';
import { collectionPage_wrap, listPages_drain, type ListPage } from '../chrisapi/contract.js';
import { errorStack } from '../error/errorStack.js';
import { Result, Ok, Err } from '../utils/result.js';
import { CHRIS_GROUP_SHAPE, type ChrisGroup } from '../groups/chrisGroups.js';

/**
 * Represents the currently authenticated ChRIS user.
 */
export interface ChrisUser {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
}

/** The signed-in user as CUBE answers: the id is used as a number and the name as text (a path, a passwd line). */
export const CHRIS_USER_SHAPE: Shape<ChrisUser> = shape_build<ChrisUser>('the current user')(['id', 'number'], ['username', 'string']);

/**
 * Represents the authenticated ChRIS user and their CUBE group memberships.
 *
 * @property user - The currently authenticated user.
 * @property groups - Every CUBE group to which the user belongs.
 */
export interface ChrisIdentity {
  user: ChrisUser;
  groups: ChrisGroup[];
}

/** A CUBE-local account managed independently from a federated identity. */
export interface LocalAccount {
  id: number;
  username: string;
  email: string;
  is_active: boolean;
  disabled_at: string | null;
  removed_at: string | null;
}

/** One allowed lifecycle transition for a CUBE-local account. */
export type LocalAccountAction = 'disable' | 'enable' | 'remove';

/**
 * Verifies that the current CUBE identity may use the local-account endpoint.
 *
 * @returns Success when the current identity has an administrative CUBE link.
 */
export async function localAccount_adminAccessEnsure(): Promise<Result<void>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) throw new Error('Not connected to ChRIS. Please log in.');
    if (!await client_adminUrlEnsure(client)) {
      throw new Error('Administrator privileges are required.');
    }
    return Ok(undefined);
  } catch (error: unknown) {
    errorStack.stack_push('error', error instanceof Error ? error.message : String(error));
    return Err();
  }
}

/**
 * Decodes one collection+json item into a plain local-account record.
 *
 * @param document - Collection+JSON response document.
 * @returns The decoded account, or null when the response lacks a valid item.
 */
function localAccount_decode(document: unknown): LocalAccount | null {
  const item = (document as { collection?: { items?: Array<{ data?: Array<{ name: string; value: unknown }> }> } })
    ?.collection?.items?.[0];
  if (!item?.data) return null;
  const values: Record<string, unknown> = Object.fromEntries(item.data.map(({ name, value }) => [name, value]));
  const id: number = Number(values.id);
  return Number.isInteger(id) && typeof values.username === 'string' && typeof values.email === 'string'
    ? { id, username: values.username, email: values.email, is_active: values.is_active === true,
        disabled_at: typeof values.disabled_at === 'string' ? values.disabled_at : null,
        removed_at: typeof values.removed_at === 'string' ? values.removed_at : null }
    : null;
}

/**
 * Finds one CUBE-local account by its exact username.
 *
 * @param username - Exact CUBE-local username to find.
 * @returns The matching local account or a recorded operation error.
 */
export async function localAccount_find(username: string): Promise<Result<LocalAccount>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) throw new Error('Not connected to ChRIS. Please log in.');
    const account: LocalAccount | null = localAccount_decode(await client_adminRequest(
      client, `users/?username=${encodeURIComponent(username)}`, 'get',
    ));
    if (!account) throw new Error(`No CUBE-local account named '${username}'.`);
    return Ok(account);
  } catch (error: unknown) {
    errorStack.stack_push('error', error instanceof Error ? error.message : String(error));
    return Err();
  }
}

/**
 * Creates one CUBE-local account through the administrative endpoint.
 *
 * @param username - New CUBE-local username.
 * @param email - Email address stored on the CUBE account.
 * @param password - Initial local-login password.
 * @returns The created local account or a recorded operation error.
 */
export async function localAccount_create(
  username: string, email: string, password: string,
): Promise<Result<LocalAccount>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) throw new Error('Not connected to ChRIS. Please log in.');
    const account: LocalAccount | null = localAccount_decode(await client_adminRequest(
      client, 'users/', 'post', { username, email, password },
    ));
    if (!account) throw new Error('CUBE returned no local-account record.');
    return Ok(account);
  } catch (error: unknown) {
    errorStack.stack_push('error', error instanceof Error ? error.message : String(error));
    return Err();
  }
}

/**
 * Applies one lifecycle action to a CUBE-local account.
 *
 * @param accountID - Stable local-account record identifier.
 * @param action - Lifecycle transition to apply.
 * @returns The updated local account or a recorded operation error.
 */
export async function localAccount_action(
  accountID: number, action: LocalAccountAction,
): Promise<Result<LocalAccount>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) throw new Error('Not connected to ChRIS. Please log in.');
    const account: LocalAccount | null = localAccount_decode(await client_adminRequest(
      client, `users/${accountID}/`, 'post', { action },
    ));
    if (!account) throw new Error('CUBE returned no local-account record.');
    return Ok(account);
  } catch (error: unknown) {
    errorStack.stack_push('error', error instanceof Error ? error.message : String(error));
    return Err();
  }
}

/** Current user data paired with its ChrisAPI resource. */
interface CurrentUserResource {
  resource: User;
  user: ChrisUser;
}

/**
 * Resolves the current user resource and its typed domain data.
 *
 * @returns The paired ChrisAPI resource and user data, or Err when unavailable.
 */
async function currentUserResource_get(): Promise<Result<CurrentUserResource>> {
  try {
    const client: Client | null = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS. Please log in.');
      return Err();
    }

    const resource: User = await client.getUser();
    const user: ChrisUser | null = itemData_get(resource, CHRIS_USER_SHAPE);
    if (!user) {
      errorStack.stack_push('error', 'Current user response carried no data.');
      return Err();
    }
    return Ok({ resource, user });
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to fetch current user: ${msg}`);
    return Err();
  }
}

/**
 * Fetches the currently authenticated user from ChRIS CUBE.
 *
 * @returns A Result containing ChrisUser, or Err on failure.
 */
export async function currentUser_get(): Promise<Result<ChrisUser>> {
  const current: Result<CurrentUserResource> = await currentUserResource_get();
  return current.ok ? Ok(current.value.user) : Err();
}

/**
 * Fetches the authenticated user together with all CUBE group memberships.
 *
 * @returns A Result containing the current user and their groups, or Err on
 *   connection, user, or membership lookup failure.
 */
export async function currentIdentity_get(): Promise<Result<ChrisIdentity>> {
  const current: Result<CurrentUserResource> = await currentUserResource_get();
  if (!current.ok) return Err();

  try {
    const membershipPageSize: number = 1000;
    const groups: ChrisGroup[] = await listPages_drain(
      async (offset: number, limit: number): Promise<ListPage<ChrisGroup>> => {
        const groupList: UserGroupList = await current.value.resource.getGroups({ limit, offset });
        return collectionPage_wrap(groupList, listData_get(groupList, CHRIS_GROUP_SHAPE));
      },
      { pageSize: membershipPageSize },
    );
    return Ok({ user: current.value.user, groups });
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to fetch current identity: ${msg}`);
    return Err();
  }
}
