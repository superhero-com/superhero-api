/** Classify only an already hash-verified accounting artifact, never its address or age. */
export function shortsIndexSchema(artifact: unknown): 1 | 2 {
  const aci = (artifact as { aci?: any[] })?.aci;
  const mains = Array.isArray(aci)
    ? aci.filter((entry) => entry?.contract?.kind === 'contract_main')
    : [];
  if (mains.length !== 1) throw new Error('Invalid Shorts accounting ABI');
  const main = mains[0].contract;
  const reads = Array.isArray(main.functions)
    ? main.functions.filter((fn) =>
        ['get_short', 'get_video'].includes(fn?.name),
      )
    : [];
  if (
    reads.length !== 1 ||
    reads[0].payable !== false ||
    reads[0].stateful !== false ||
    reads[0].arguments?.length !== 1 ||
    reads[0].arguments[0]?.type !== 'string'
  )
    throw new Error('Invalid Shorts accounting read ABI');
  const schema = reads[0].name === 'get_video' ? 2 : 1;
  const variants = main.event?.variant;
  if (
    !Array.isArray(variants) ||
    variants.some(
      (variant) =>
        !variant || typeof variant !== 'object' || Array.isArray(variant),
    )
  )
    throw new Error('Missing Shorts accounting events');
  const signature = (name: string, expected: string[], required: boolean) => {
    const found = variants.filter((variant) => Object.hasOwn(variant, name));
    if (
      (required ? found.length !== 1 : found.length > 1) ||
      (found.length === 1 &&
        (Object.keys(found[0]).length !== 1 ||
          JSON.stringify(found[0][name]) !== JSON.stringify(expected)))
    )
      throw new Error('Inconsistent Shorts accounting event ABI');
  };
  const paid = variants.some((variant) => Object.hasOwn(variant, 'PaidLike'));
  const free = variants.some((variant) => Object.hasOwn(variant, 'Liked'));
  if ((schema === 1 && (!paid || free)) || (schema === 2 && paid === free))
    throw new Error('Ambiguous Shorts accounting event family');
  signature(
    'PaidLike',
    schema === 2
      ? ['address', 'int', 'int', 'string']
      : ['address', 'int', 'string'],
    paid,
  );
  signature('Liked', ['address', 'int', 'string'], free);
  // The earliest paid contract has Activated instead of Published.
  signature(
    'Published',
    schema === 2 ? ['address', 'int', 'string'] : ['address', 'string'],
    false,
  );
  signature('Claimed', ['address', 'int'], false);
  signature('Withdrawn', ['string'], false);
  return schema;
}
