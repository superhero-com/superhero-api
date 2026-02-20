export const extractProfileMutationPayload = (tx: any): any => {
  const candidates = [tx?.tx?.tx?.tx, tx?.tx?.tx, tx?.tx, tx];
  const matched = candidates.find((candidate) => {
    const contractId = candidate?.contractId || candidate?.contract_id;
    const fn = candidate?.function;
    return !!contractId && !!fn;
  });
  return matched || tx?.tx || tx;
};

export const extractProfileMutationContractId = (tx: any): string => {
  const payload = extractProfileMutationPayload(tx);
  return (
    payload?.contractId?.toString?.() ||
    payload?.contract_id?.toString?.() ||
    tx?.contractId?.toString?.() ||
    tx?.contract_id?.toString?.() ||
    ''
  );
};

export const extractProfileMutationFunction = (tx: any): string => {
  const payload = extractProfileMutationPayload(tx);
  return (
    payload?.function?.toString?.() ||
    tx?.function?.toString?.() ||
    ''
  );
};

export const extractProfileMutationCaller = (tx: any): string | null => {
  const payload = extractProfileMutationPayload(tx);
  return (
    payload?.callerId?.toString?.() ||
    payload?.caller_id?.toString?.() ||
    tx?.callerId?.toString?.() ||
    tx?.caller_id?.toString?.() ||
    null
  );
};

export const extractProfileMutationRawLog = (tx: any): any[] => {
  const payload = extractProfileMutationPayload(tx);
  const rawLog =
    payload?.log ||
    tx?.tx?.log ||
    tx?.tx?.tx?.log ||
    tx?.tx?.tx?.tx?.log ||
    tx?.log ||
    tx?.raw?.log ||
    [];
  return Array.isArray(rawLog) ? rawLog : [];
};

export const isSuccessfulProfileMutation = (tx: any): boolean => {
  const payload = extractProfileMutationPayload(tx);
  if (tx?.pending === true || tx?.tx?.pending === true || payload?.pending === true) {
    return false;
  }
  const returnType = (
    payload?.returnType ||
    payload?.return_type ||
    tx?.tx?.returnType ||
    tx?.tx?.return_type ||
    tx?.returnType ||
    tx?.return_type ||
    ''
  )
    .toString()
    .toLowerCase();
  if (!returnType) {
    return false;
  }
  return returnType !== 'revert';
};

export const extractProfileMutationXUsername = (tx: any): string | null => {
  const payload = extractProfileMutationPayload(tx);
  const username =
    payload?.arguments?.[0]?.value?.toString?.() ||
    tx?.arguments?.[0]?.value?.toString?.() ||
    null;
  if (!username) {
    return null;
  }
  return username.trim().toLowerCase().replace(/^@+/, '');
};
