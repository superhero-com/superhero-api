declare const React: any;
const { useCallback, useEffect, useMemo, useState } = React;

type DisplaySource = 'custom' | 'chain' | 'x';

type NameSet = {
  custom_name: string | null;
  chain_name: string | null;
  x_name: string | null;
};

type ProfileData = {
  fullname: string;
  bio: string;
  avatarurl: string;
  username: string | null;
  chain_name: string | null;
  x_username: string | null;
  display_source: DisplaySource | string | null;
  chain_expires_at: string | null;
};

type ProfileAggregate = {
  address: string;
  profile: ProfileData;
  public_name: string | null;
  names: NameSet;
};

type ProfileFeedResponse = {
  items: ProfileAggregate[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

type XAttestation = {
  signer: string;
  address: string;
  x_username: string;
  nonce: string;
  expiry: number;
  message: string;
  signature_hex: string;
  signature_base64: string;
};

type WalletAdapter = {
  // Implement using your wallet SDK.
  callProfileContract: (
    entrypoint: string,
    args: unknown[],
  ) => Promise<{ txHash: string }>;
};

type ContractReader = {
  // Optional dry-run fallback for reads. Can be omitted in prod.
  dryRunGetProfile: (address: string) => Promise<ProfileAggregate | null>;
};

type UserProfileProps = {
  backendBaseUrl: string;
  currentAddress: string;
  wallet: WalletAdapter;
  contractReader?: ContractReader;
  enableDryRunFallback?: boolean;
};

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchProfileFromBackend(
  backendBaseUrl: string,
  address: string,
): Promise<ProfileAggregate> {
  return getJson<ProfileAggregate>(
    `${backendBaseUrl}/api/profile/${address}`,
  );
}

async function fetchProfileOnChainFromBackend(
  backendBaseUrl: string,
  address: string,
): Promise<ProfileAggregate | null> {
  // Backend endpoint that performs contract dry-run, no user payment needed.
  return getJson<ProfileAggregate | null>(
    `${backendBaseUrl}/api/profile/${address}/onchain`,
  );
}

async function fetchFeedFromBackend(
  backendBaseUrl: string,
  limit = 20,
  offset = 0,
): Promise<ProfileFeedResponse> {
  return getJson<ProfileFeedResponse>(
    `${backendBaseUrl}/api/profile/feed?limit=${limit}&offset=${offset}`,
  );
}

async function fetchBatchProfilesFromBackend(
  backendBaseUrl: string,
  addresses: string[],
): Promise<ProfileAggregate[]> {
  const q = encodeURIComponent(addresses.join(','));
  return getJson<ProfileAggregate[]>(
    `${backendBaseUrl}/api/profile?addresses=${q}`,
  );
}

async function createXAttestation(
  backendBaseUrl: string,
  address: string,
  accessToken: string,
): Promise<XAttestation> {
  return postJson<XAttestation>(`${backendBaseUrl}/api/profile/x/attestation`, {
    address,
    accessToken,
  });
}

async function fetchProfileHybrid(params: {
  backendBaseUrl: string;
  address: string;
  enableDryRunFallback: boolean;
  contractReader?: ContractReader;
}): Promise<ProfileAggregate | null> {
  const { backendBaseUrl, address, enableDryRunFallback, contractReader } = params;
  try {
    return await fetchProfileFromBackend(backendBaseUrl, address);
  } catch (backendError) {
    if (!enableDryRunFallback) {
      throw backendError;
    }

    // 1) Backend onchain endpoint fallback.
    try {
      const backendOnchain = await fetchProfileOnChainFromBackend(
        backendBaseUrl,
        address,
      );
      if (backendOnchain) {
        return backendOnchain;
      }
    } catch {
      // Ignore and fallback to direct reader.
    }

    // 2) Optional direct dry-run reader fallback.
    if (contractReader) {
      return contractReader.dryRunGetProfile(address);
    }
    return null;
  }
}

export default function UserProfile(props: UserProfileProps) {
  const {
    backendBaseUrl,
    currentAddress,
    wallet,
    contractReader,
    enableDryRunFallback = true,
  } = props;

  const [profile, setProfile] = useState(null as ProfileAggregate | null);
  const [feed, setFeed] = useState([] as ProfileAggregate[]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null as string | null);

  const [fullname, setFullname] = useState('');
  const [bio, setBio] = useState('');
  const [avatarurl, setAvatarurl] = useState('');
  const [customName, setCustomName] = useState('');
  const [chainName, setChainName] = useState('');
  const [chainExpiresAt, setChainExpiresAt] = useState('');
  const [displaySource, setDisplaySource] = useState('custom' as DisplaySource);
  const [xOAuthToken, setXOAuthToken] = useState('');

  const syncFormFromProfile = useCallback((value: ProfileAggregate | null) => {
    if (!value) {
      return;
    }
    setFullname(value.profile.fullname || '');
    setBio(value.profile.bio || '');
    setAvatarurl(value.profile.avatarurl || '');
    setCustomName(value.names.custom_name || '');
    setChainName(value.names.chain_name || '');
    setDisplaySource(
      (value.profile.display_source as DisplaySource) || 'custom',
    );
    setChainExpiresAt(value.profile.chain_expires_at || '');
  }, []);

  const refreshCurrentProfile = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchProfileHybrid({
        backendBaseUrl,
        address: currentAddress,
        enableDryRunFallback,
        contractReader,
      });
      setProfile(next);
      syncFormFromProfile(next);
    } catch (e: any) {
      setError(e?.message || 'Failed to fetch profile');
    } finally {
      setIsLoading(false);
    }
  }, [
    backendBaseUrl,
    currentAddress,
    enableDryRunFallback,
    contractReader,
    syncFormFromProfile,
  ]);

  const refreshFeed = useCallback(async () => {
    try {
      // Scalable mode: backend cache endpoint for social feed.
      const feedResponse = await fetchFeedFromBackend(backendBaseUrl, 20, 0);
      setFeed(feedResponse.items);
    } catch (e: any) {
      setError(e?.message || 'Failed to fetch feed');
    }
  }, [backendBaseUrl]);

  useEffect(() => {
    refreshCurrentProfile();
    refreshFeed();
  }, [refreshCurrentProfile, refreshFeed]);

  useEffect(() => {
    // Polling demo; in production use websocket/SSE where possible.
    const id = setInterval(() => {
      refreshFeed();
    }, 10000);
    return () => clearInterval(id);
  }, [refreshFeed]);

  const txPayloadPreview = useMemo(() => {
    return {
      set_profile: [fullname, bio, avatarurl],
      set_custom_name: [normalizeName(customName)],
      set_chain_name: [
        normalizeName(chainName),
        chainExpiresAt ? Number(chainExpiresAt) : null,
      ],
      set_display_source: [displaySource],
    };
  }, [fullname, bio, avatarurl, customName, chainName, chainExpiresAt, displaySource]);

  async function saveProfileBasics() {
    await wallet.callProfileContract('set_profile', [fullname, bio, avatarurl]);

    const normalizedCustom = normalizeName(customName);
    if (normalizedCustom) {
      await wallet.callProfileContract('set_custom_name', [normalizedCustom]);
    }

    await wallet.callProfileContract('set_display_source', [displaySource]);
    await refreshCurrentProfile();
  }

  async function saveChainName() {
    const normalizedChain = normalizeName(chainName);
    const expires = Number(chainExpiresAt);
    if (!normalizedChain || !Number.isFinite(expires)) {
      throw new Error('Provide valid chain name and expires timestamp');
    }
    await wallet.callProfileContract('set_chain_name', [normalizedChain, expires]);
    await refreshCurrentProfile();
  }

  async function verifyXAndSave() {
    if (!xOAuthToken) {
      throw new Error('Missing X OAuth token');
    }

    // Backend verifies X token and signs attestation.
    const attestation = await createXAttestation(
      backendBaseUrl,
      currentAddress,
      xOAuthToken,
    );

    // Wallet sends paid transaction once; contract verifies signature.
    await wallet.callProfileContract('set_x_name_with_attestation', [
      attestation.x_username,
      attestation.expiry,
      attestation.nonce,
      hexToUint8Array(attestation.signature_hex),
    ]);

    await refreshCurrentProfile();
  }

  async function refreshBatchForVisibleUsers(addresses: string[]) {
    // Useful for social timeline view where many cards are visible.
    const profiles = await fetchBatchProfilesFromBackend(backendBaseUrl, addresses);
    setFeed(profiles);
  }

  return React.createElement(
    'div',
    { style: { fontFamily: 'sans-serif', display: 'grid', gap: 16 } },
    React.createElement('h2', null, 'User Profile'),
    React.createElement('div', null, `Address: ${currentAddress}`),
    isLoading ? React.createElement('div', null, 'Loading...') : null,
    error
      ? React.createElement('div', { style: { color: 'red' } }, error)
      : null,
    React.createElement(
      'section',
      { style: { border: '1px solid #ddd', padding: 12 } },
      React.createElement('h3', null, 'Edit profile'),
      React.createElement('input', {
        placeholder: 'Full name',
        value: fullname,
        onChange: (e: any) => setFullname(e.target.value),
      }),
      React.createElement('textarea', {
        placeholder: 'Bio',
        value: bio,
        onChange: (e: any) => setBio(e.target.value),
      }),
      React.createElement('input', {
        placeholder: 'Avatar URL',
        value: avatarurl,
        onChange: (e: any) => setAvatarurl(e.target.value),
      }),
      React.createElement('input', {
        placeholder: 'Custom name',
        value: customName,
        onChange: (e: any) => setCustomName(e.target.value),
      }),
      React.createElement(
        'select',
        {
          value: displaySource,
          onChange: (e: any) => setDisplaySource(e.target.value as DisplaySource),
        },
        React.createElement('option', { value: 'custom' }, 'custom'),
        React.createElement('option', { value: 'chain' }, 'chain'),
        React.createElement('option', { value: 'x' }, 'x'),
      ),
      React.createElement(
        'button',
        { onClick: () => void saveProfileBasics() },
        'Save basics',
      ),
    ),
    React.createElement(
      'section',
      { style: { border: '1px solid #ddd', padding: 12 } },
      React.createElement('h3', null, 'Set chain name'),
      React.createElement('input', {
        placeholder: 'chain_name',
        value: chainName,
        onChange: (e: any) => setChainName(e.target.value),
      }),
      React.createElement('input', {
        placeholder: 'expires_at (unix sec)',
        value: chainExpiresAt,
        onChange: (e: any) => setChainExpiresAt(e.target.value),
      }),
      React.createElement(
        'button',
        { onClick: () => void saveChainName() },
        'Save chain name',
      ),
    ),
    React.createElement(
      'section',
      { style: { border: '1px solid #ddd', padding: 12 } },
      React.createElement('h3', null, 'Verify X'),
      React.createElement('input', {
        placeholder: 'X OAuth access token',
        value: xOAuthToken,
        onChange: (e: any) => setXOAuthToken(e.target.value),
      }),
      React.createElement(
        'button',
        { onClick: () => void verifyXAndSave() },
        'Verify X and save x_name',
      ),
    ),
    React.createElement(
      'section',
      { style: { border: '1px solid #ddd', padding: 12 } },
      React.createElement('h3', null, 'Current profile'),
      React.createElement('pre', null, JSON.stringify(profile, null, 2)),
      React.createElement('h4', null, 'Prepared tx args preview'),
      React.createElement('pre', null, JSON.stringify(txPayloadPreview, null, 2)),
    ),
    React.createElement(
      'section',
      { style: { border: '1px solid #ddd', padding: 12 } },
      React.createElement('h3', null, 'Social feed profiles (backend cache)'),
      React.createElement(
        'button',
        {
          onClick: () =>
            void refreshBatchForVisibleUsers(feed.map((item) => item.address)),
        },
        'Refresh visible via batch',
      ),
      ...feed.map((item) =>
        React.createElement(
          'div',
          { key: item.address, style: { marginTop: 8 } },
          React.createElement('strong', null, item.public_name || item.address),
          React.createElement('div', null, item.profile.bio),
        ),
      ),
    ),
  );
}
