/** Push services of Chrome/Chromium, Firefox, Safari and Edge (WNS). */
export const DEFAULT_PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

/** Host suffixes from `WEB_PUSH_ALLOWED_HOSTS` (comma-separated); empty = defaults. */
export function pushServiceHosts(
  raw: string | undefined = process.env.WEB_PUSH_ALLOWED_HOSTS,
): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return hosts.length > 0 ? hosts : [...DEFAULT_PUSH_SERVICE_HOSTS];
}

/**
 * The endpoint as a URL if it is a default-port HTTPS URL on an allowed push
 * service, else null. The sender connects to this same URL object, so the check
 * and the request can never disagree about the host.
 */
export function parsePushEndpoint(
  endpoint: string,
  allowedHosts: readonly string[],
): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  const host = url.hostname;
  return allowedHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  )
    ? url
    : null;
}
