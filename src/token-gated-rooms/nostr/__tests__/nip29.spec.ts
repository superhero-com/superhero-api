import {
  createGroup,
  deleteGroup,
  editMetadata,
  NIP29_KIND,
  putUser,
  removeUser,
  setRoles,
} from '../nip29';

const GID = 'ct_MixedCaseGroupId123';

describe('nip29 builders', () => {
  describe('createGroup (9007)', () => {
    it('emits kind 9007 with only the h tag (group id first, verbatim)', () => {
      const t = createGroup(GID);
      expect(t.kind).toBe(NIP29_KIND.CREATE_GROUP);
      expect(t.kind).toBe(9007);
      expect(t.tags).toEqual([['h', GID]]);
      expect(t.content).toBe('');
    });
  });

  describe('editMetadata (9002)', () => {
    it('public room: h first, name/about, public, closed', () => {
      const t = editMetadata(GID, {
        name: '$FOO',
        about: 'a foo room',
        isPrivate: false,
      });
      expect(t.kind).toBe(9002);
      expect(t.tags).toEqual([
        ['h', GID],
        ['name', '$FOO'],
        ['about', 'a foo room'],
        ['public'],
        ['closed'],
      ]);
    });

    it('private room: emits ["private"] instead of ["public"], always closed', () => {
      const t = editMetadata(GID, {
        name: '$FOO',
        about: 'a foo room',
        isPrivate: true,
      });
      expect(t.tags).toContainEqual(['private']);
      expect(t.tags).not.toContainEqual(['public']);
      expect(t.tags).toContainEqual(['closed']);
      // h tag is always first.
      expect(t.tags[0]).toEqual(['h', GID]);
    });

    it('defaults to public + closed and omits name/about when absent', () => {
      const t = editMetadata(GID);
      expect(t.tags).toEqual([['h', GID], ['public'], ['closed']]);
    });

    it('never emits a previous tag', () => {
      const t = editMetadata(GID, { name: 'x', about: 'y', isPrivate: true });
      expect(t.tags.some((tag) => tag[0] === 'previous')).toBe(false);
    });
  });

  describe('putUser (9000)', () => {
    const PK = 'a'.repeat(64);

    it('plain member add: ["p", pubkey] (no role element)', () => {
      const t = putUser(GID, PK);
      expect(t.kind).toBe(9000);
      expect(t.tags).toEqual([
        ['h', GID],
        ['p', PK],
      ]);
    });

    it('add with role: ["p", pubkey, role]', () => {
      const t = putUser(GID, PK, 'admin');
      expect(t.tags).toEqual([
        ['h', GID],
        ['p', PK, 'admin'],
      ]);
    });
  });

  describe('removeUser (9001)', () => {
    const PK = 'b'.repeat(64);
    it('emits kind 9001 with h first then p', () => {
      const t = removeUser(GID, PK);
      expect(t.kind).toBe(9001);
      expect(t.tags).toEqual([
        ['h', GID],
        ['p', PK],
      ]);
    });
  });

  describe('setRoles (9006)', () => {
    const PK = 'c'.repeat(64);
    it('emits kind 9006 with p tag carrying pubkey then roles', () => {
      const t = setRoles(GID, PK, ['admin', 'moderator']);
      expect(t.kind).toBe(9006);
      expect(t.tags).toEqual([
        ['h', GID],
        ['p', PK, 'admin', 'moderator'],
      ]);
    });
  });

  describe('deleteGroup (9008)', () => {
    it('emits kind 9008 with only the h tag', () => {
      const t = deleteGroup(GID);
      expect(t.kind).toBe(9008);
      expect(t.tags).toEqual([['h', GID]]);
    });
  });

  it('no builder emits a previous tag', () => {
    const PK = 'd'.repeat(64);
    const templates = [
      createGroup(GID),
      editMetadata(GID, { name: 'n', about: 'a', isPrivate: false }),
      putUser(GID, PK),
      putUser(GID, PK, 'admin'),
      removeUser(GID, PK),
      setRoles(GID, PK, ['admin']),
      deleteGroup(GID),
    ];
    for (const t of templates) {
      expect(t.tags.some((tag) => tag[0] === 'previous')).toBe(false);
      expect(t.tags[0][0]).toBe('h'); // h-tag always first
    }
  });
});
