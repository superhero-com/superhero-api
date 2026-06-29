import {
  NostrRoomState,
  NOSTR_ROOM_STATES,
  NOSTR_ROOM_STATE_DEFAULT,
  NOSTR_ROOM_STATE_TRANSITIONS,
  isLegalNostrRoomStateTransition,
} from './nostr-room-state.enum';

describe('nostr-room-state transition table (plan §4.7)', () => {
  it('declares the five canonical states with `none` as default', () => {
    expect([...NOSTR_ROOM_STATES]).toEqual([
      'none',
      'pending',
      'created',
      'failed',
      'deleted',
    ]);
    expect(NOSTR_ROOM_STATE_DEFAULT).toBe('none');
  });

  it('encodes exactly the §4.7 adjacency', () => {
    expect(NOSTR_ROOM_STATE_TRANSITIONS).toEqual({
      none: ['pending'],
      pending: ['created', 'failed', 'deleted'],
      created: ['deleted'],
      failed: ['pending'],
      deleted: [],
    });
  });

  describe('legal transitions', () => {
    const legal: Array<[NostrRoomState, NostrRoomState]> = [
      ['none', 'pending'],
      ['pending', 'created'], // relay ACK / "Group already exists"
      ['pending', 'failed'],
      ['failed', 'pending'], // retry, capped backoff
      ['created', 'deleted'],
      ['pending', 'deleted'],
    ];
    it.each(legal)('allows %s → %s', (from, to) => {
      expect(isLegalNostrRoomStateTransition(from, to)).toBe(true);
    });
  });

  describe('illegal transitions', () => {
    const illegal: Array<[NostrRoomState, NostrRoomState]> = [
      ['created', 'pending'], // cannot un-create
      ['created', 'failed'],
      ['none', 'created'], // must go through pending
      ['none', 'failed'],
      ['failed', 'created'],
      ['pending', 'none'],
    ];
    it.each(illegal)('rejects %s → %s', (from, to) => {
      expect(isLegalNostrRoomStateTransition(from, to)).toBe(false);
    });
  });

  it('treats `deleted` as terminal (no outgoing transitions)', () => {
    expect([...NOSTR_ROOM_STATE_TRANSITIONS.deleted]).toEqual([]);
    for (const to of NOSTR_ROOM_STATES) {
      expect(isLegalNostrRoomStateTransition('deleted', to)).toBe(false);
    }
  });
});
