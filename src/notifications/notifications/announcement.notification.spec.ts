import { AnnouncementNotification } from './announcement.notification';

describe('AnnouncementNotification', () => {
  const params = {
    id: 42,
    title: 'Maintenance',
    description: 'Down at 02:00 UTC.',
  };

  it('routes through the expo channel', () => {
    const n = new AnnouncementNotification(params);
    expect(n.via()).toEqual(['expo']);
    expect(n.type).toBe('announcement');
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(AnnouncementNotification.META).toEqual({
      type: 'announcement',
      title: 'Announcements',
      description: 'Updates and news from the Superhero team.',
    });
    const n = new AnnouncementNotification(params);
    expect(n.type).toBe(AnnouncementNotification.META.type);
    expect(n.title).toBe(AnnouncementNotification.META.title);
    expect(n.description).toBe(AnnouncementNotification.META.description);
  });

  it('builds a per-(announcement, recipient) dedup key', () => {
    const n = new AnnouncementNotification(params);
    expect(n.dedupKey({ address: 'ak_alice' as any })).toBe(
      'announcement:42:ak_alice',
    );
  });

  it('renders the expo message from title/description with a deep-link id', () => {
    const n = new AnnouncementNotification(params);
    const msg = n.toExpo();
    expect(msg.title).toBe('Maintenance');
    expect(msg.body).toBe('Down at 02:00 UTC.');
    expect(msg.data).toMatchObject({
      type: 'announcement',
      announcementId: 42,
    });
  });
});
