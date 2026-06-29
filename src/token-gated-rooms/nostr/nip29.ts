/**
 * Pure NIP-29 management-event TEMPLATE builders for `groups_relay` (Task 07).
 *
 * Each builder is side-effect free: it returns `{ kind, tags, content }` ready to
 * be finalized+signed by the relay writer. The `["h", groupId]` tag is ALWAYS
 * first (the relay reads the group id off it verbatim — `extract_group_id`,
 * `group.rs:1370`), and the group id is passed in already-resolved
 * (`group-id.ts#groupIdFor`) — these builders never derive or normalize it.
 *
 * We deliberately do NOT emit a NIP-29 `previous` tag: `groups_relay`
 * `validate_event` (`validation_middleware.rs:23`) requires only the `h` tag and
 * does not enforce `previous`. Mirrors the bot's `NostrRoomManagement` builders.
 *
 * Kind reference (NIP-29 / `groups_relay`):
 *   9007 create-group · 9002 edit-metadata · 9000 put-user · 9001 remove-user ·
 *   9006 set-roles · 9008 delete-group.
 */

/** A finalize-ready event template (no `created_at`/`pubkey`/`sig` yet). */
export interface Nip29Template {
  kind: number;
  tags: string[][];
  content?: string;
}

/** NIP-29 management kinds (groups_relay constants). */
export const NIP29_KIND = {
  CREATE_GROUP: 9007,
  EDIT_METADATA: 9002,
  PUT_USER: 9000,
  REMOVE_USER: 9001,
  SET_ROLES: 9006,
  DELETE_GROUP: 9008,
} as const;

export interface EditMetadataOptions {
  name?: string;
  about?: string;
  /** Private groups gate reads (require NIP-42 AUTH); public are world-readable. */
  isPrivate?: boolean;
}

/**
 * kind 9007 — create the group. A fresh create makes the signer admin; over a
 * pre-existing managed group the relay returns `"Group already exists"` (benign
 * no-op) and over a pre-existing unmanaged `h` only the relay admin may create.
 */
export function createGroup(groupId: string): Nip29Template {
  return {
    kind: NIP29_KIND.CREATE_GROUP,
    tags: [['h', groupId]],
    content: '',
  };
}

/**
 * kind 9002 — edit group metadata (replaceable). Token-gated rooms are ALWAYS
 * `closed`; `private`/`public` is driven by the token's privacy. Mirrors the
 * reference builder's tag order: name, about, private|public, closed.
 */
export function editMetadata(
  groupId: string,
  { name, about, isPrivate }: EditMetadataOptions = {},
): Nip29Template {
  const tags: string[][] = [['h', groupId]];
  if (name !== undefined) {
    tags.push(['name', name]);
  }
  if (about !== undefined) {
    tags.push(['about', about]);
  }
  tags.push(isPrivate ? ['private'] : ['public']);
  tags.push(['closed']);
  return { kind: NIP29_KIND.EDIT_METADATA, tags, content: '' };
}

/**
 * kind 9000 — put (add/upgrade) a user. With a `role` the `p` tag carries it
 * (`["p", pubkey, role]`), otherwise a plain member add (`["p", pubkey]`).
 */
export function putUser(
  groupId: string,
  pubkey: string,
  role?: string,
): Nip29Template {
  const pTag = role ? ['p', pubkey, role] : ['p', pubkey];
  return {
    kind: NIP29_KIND.PUT_USER,
    tags: [['h', groupId], pTag],
    content: '',
  };
}

/** kind 9001 — remove a user (revokes post, and read in private groups). */
export function removeUser(groupId: string, pubkey: string): Nip29Template {
  return {
    kind: NIP29_KIND.REMOVE_USER,
    tags: [
      ['h', groupId],
      ['p', pubkey],
    ],
    content: '',
  };
}

/**
 * kind 9006 — set a user's roles. One `p` tag carrying the pubkey followed by
 * each role: `["p", pubkey, role1, role2, …]`.
 */
export function setRoles(
  groupId: string,
  pubkey: string,
  roles: string[],
): Nip29Template {
  return {
    kind: NIP29_KIND.SET_ROLES,
    tags: [
      ['h', groupId],
      ['p', pubkey, ...roles],
    ],
    content: '',
  };
}

/** kind 9008 — delete the group (terminal; the relay refuses to re-create it). */
export function deleteGroup(groupId: string): Nip29Template {
  return {
    kind: NIP29_KIND.DELETE_GROUP,
    tags: [['h', groupId]],
    content: '',
  };
}
