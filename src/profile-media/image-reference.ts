/** Portable image names. The directory CID commits both image.webp and thumb.webp. */
export const IMAGE_REFERENCE_PREFIX = 'ipfs:superhero:images:';
export const PROFILE_IMAGE_REFERENCE_PREFIX = 'ipfs_superhero_images_';
export const imageReference = (cid: string, preview = false): string =>
  `${IMAGE_REFERENCE_PREFIX}${cid}${preview ? '-preview' : ''}`;
// AddressLink values cannot contain colons; the CID still identifies both files.
export const profileImageReference = (cid: string): string =>
  `${PROFILE_IMAGE_REFERENCE_PREFIX}${cid}`;

export function parseImageReference(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const match = /^ipfs:superhero:images:(bafy[a-z2-7]{55})(-preview)?$/.exec(
    value,
  );
  return match ? { cid: match[1], preview: !!match[2] } : undefined;
}

/** Normalize new profile links and the bare CIDs used by earlier versions. */
export function profileImageCid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const chainValue = /^(?:ipfs_superhero_images_)?(bafy[a-z2-7]{55})$/.exec(
    value,
  );
  if (chainValue) return chainValue[1];
  const reference = parseImageReference(value);
  return reference && !reference.preview ? reference.cid : undefined;
}
