/** CID-affecting request options shared by original and prepared-file imports.
 * Keep these aligned with the private storage gateway and pinned Kubo config.
 */
export const SHORTS_IPFS_CHUNK_BYTES = 262144;
export const SHORTS_IPFS_FILE_MAX_LINKS = 174;
export const SHORTS_IPFS_IMPORT_OPTIONS = Object.freeze({
  'cid-version': '1',
  'raw-leaves': 'true',
  chunker: `size-${SHORTS_IPFS_CHUNK_BYTES}`,
  hash: 'sha2-256',
  trickle: 'false',
  'max-file-links': String(SHORTS_IPFS_FILE_MAX_LINKS),
  'max-directory-links': '0',
  'max-hamt-fanout': '256',
  inline: 'false',
  'preserve-mode': 'false',
  'preserve-mtime': 'false',
});
export const SHORTS_IPFS_IMPORT_QUERY = new URLSearchParams(
  SHORTS_IPFS_IMPORT_OPTIONS,
).toString();
