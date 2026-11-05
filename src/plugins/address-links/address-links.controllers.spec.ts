import { MemoryAccount } from '@aeternity/aepp-sdk';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
} from 'nostr-tools';
import request from 'supertest';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { OAuthService } from '@/affiliation/services/oauth.service';
import { AddressLinksService } from './address-links.service';
import { BioLinkController } from './bio-link.controller';
import { AddressLinksContractService } from './contract.service';
import { NostrLinkController } from './nostr-link.controller';
import { PreferredLinkController } from './preferred-link.controller';
import { SiteLinkController } from './site-link.controller';
import { BioLinkVerifierService } from './verification/bio-link-verifier.service';
import { NostrLinkVerifierService } from './verification/nostr-link-verifier.service';
import { PreferredLinkVerifierService } from './verification/preferred-link-verifier.service';
import { SiteLinkVerifierService } from './verification/site-link-verifier.service';
import { XLinkVerifierService } from './verification/x-link-verifier.service';
import { XLinkController } from './x-link.controller';

const ADDRESS = MemoryAccount.generate().address;
const OTHER_ADDRESS = MemoryAccount.generate().address;
const NONCE = 7;
const SIGNATURE = 'ab'.repeat(64);
const PROVIDER_ACCOUNT = { address: 'ak_provider' };
const SIGNED_BY_PROVIDER = [
  Buffer.from(SIGNATURE, 'hex'),
  { onAccount: PROVIDER_ACCOUNT },
];
const X_CODE = {
  x_code: 'oauth-code',
  x_code_verifier: 'pkce-verifier',
  x_redirect_uri: 'https://superhero.com/x/callback',
};
const nostrKey = generateSecretKey();
const NPUB: string = nip19.npubEncode(getPublicKey(nostrKey));

const nostrProof = (message: string, key = nostrKey) =>
  JSON.stringify(
    finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: message,
      },
      key,
    ),
  );

type Claim = {
  message: string;
  nonce: number;
  value: string;
  verification_token?: string;
};

interface LinkFlow {
  path: string;
  claim: object;
  message: string;
  submit: (claim: Claim) => object;
  entrypoint: 'link' | 'link_principal';
  linked: unknown[];
}

const withToken = (value: string) => (claim: Claim) => ({
  address: ADDRESS,
  value,
  nonce: claim.nonce,
  signature: SIGNATURE,
  verification_token: claim.verification_token,
});

const flows: Record<string, LinkFlow> = {
  x: {
    path: 'x',
    claim: { address: ADDRESS, ...X_CODE },
    message: `link:${ADDRESS}:x:alice_x:${NONCE}`,
    submit: withToken('alice_x'),
    entrypoint: 'link',
    linked: [ADDRESS, 'x', 'alice_x', NONCE],
  },
  nostr: {
    path: 'nostr',
    claim: { address: ADDRESS, value: NPUB },
    message: `link:${ADDRESS}:nostr:${NPUB}:${NONCE}`,
    submit: (claim) => ({
      address: ADDRESS,
      value: NPUB,
      nonce: claim.nonce,
      signature: SIGNATURE,
      nostr_event: nostrProof(claim.message),
    }),
    entrypoint: 'link',
    linked: [ADDRESS, 'nostr', NPUB, NONCE],
  },
  bio: {
    path: 'bio',
    claim: { address: ADDRESS, value: '  Hello there  ' },
    message: `link:${ADDRESS}:bio:Hello there:${NONCE}`,
    submit: withToken('  Hello there  '),
    entrypoint: 'link',
    linked: [ADDRESS, 'bio', 'Hello there', NONCE],
  },
  site: {
    path: 'site',
    claim: { address: ADDRESS, value: 'https://Example.com/blog/' },
    message: `link:${ADDRESS}:site:example.com/blog:${NONCE}`,
    submit: withToken('https://Example.com/blog/'),
    entrypoint: 'link',
    linked: [ADDRESS, 'site', 'example.com/blog', NONCE],
  },
  'preferred name': {
    path: 'prefered-aens-name',
    claim: { address: ADDRESS, value: 'Hero.chain' },
    message: `link:hero.chain:prefaens:hero.chain:${NONCE}`,
    submit: withToken('Hero.chain'),
    entrypoint: 'link_principal',
    linked: ['hero.chain', ADDRESS, 'prefaens', 'hero.chain', NONCE],
  },
};

const signed = { nonce: NONCE, signature: SIGNATURE };
const routes: Array<[string, object]> = [
  ['x/claim', { address: ADDRESS, ...X_CODE }],
  [
    'x/submit',
    { address: ADDRESS, value: 'a', ...signed, verification_token: 't' },
  ],
  ['x/unclaim', { address: ADDRESS }],
  ['x/unclaim/submit', { address: ADDRESS, ...signed }],
  ['nostr/claim', { address: ADDRESS, value: NPUB }],
  [
    'nostr/submit',
    { address: ADDRESS, value: NPUB, ...signed, nostr_event: '{}' },
  ],
  ['nostr/unclaim', { address: ADDRESS }],
  ['nostr/unclaim/submit', { address: ADDRESS, ...signed }],
  ['bio/claim', { address: ADDRESS, value: 'a' }],
  [
    'bio/submit',
    { address: ADDRESS, value: 'a', ...signed, verification_token: 't' },
  ],
  ['bio/unclaim', { address: ADDRESS }],
  ['bio/unclaim/submit', { address: ADDRESS, ...signed }],
  ['site/claim', { address: ADDRESS, value: 'a.com' }],
  [
    'site/submit',
    { address: ADDRESS, value: 'a.com', ...signed, verification_token: 't' },
  ],
  ['site/unclaim', { address: ADDRESS }],
  ['site/unclaim/submit', { address: ADDRESS, ...signed }],
  ['prefered-aens-name/claim', { address: ADDRESS, value: 'hero.chain' }],
  [
    'prefered-aens-name/submit',
    {
      address: ADDRESS,
      value: 'hero.chain',
      ...signed,
      verification_token: 't',
    },
  ],
  ['prefered-aens-name/unclaim', { address: ADDRESS }],
  [
    'prefered-aens-name/unclaim/submit',
    { address: ADDRESS, value: 'hero.chain', ...signed },
  ],
];

describe('address-link routes (HTTP)', () => {
  let app: INestApplication;
  const contract: Record<string, jest.Mock> = {
    get_nonce: jest.fn(),
    get_nonce_principal: jest.fn(),
    get_link: jest.fn(),
    link: jest.fn(),
    unlink: jest.fn(),
    link_principal: jest.fn(),
    unlink_principal: jest.fn(),
  };
  const oauthService = {
    exchangeXCodeForAccessToken: jest.fn(),
    verifyAccessToken: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        XLinkController,
        NostrLinkController,
        BioLinkController,
        SiteLinkController,
        PreferredLinkController,
      ],
      providers: [
        AddressLinksService,
        AddressLinksContractService,
        XLinkVerifierService,
        NostrLinkVerifierService,
        BioLinkVerifierService,
        SiteLinkVerifierService,
        PreferredLinkVerifierService,
        { provide: AeSdkService, useValue: {} },
        { provide: OAuthService, useValue: oauthService },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Same options as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    // Only the chain is faked: signature decoding, error mapping and the
    // provider wallet all run for real.
    const contractService = moduleRef.get(AddressLinksContractService);
    jest
      .spyOn(contractService as any, 'getContractInstance')
      .mockResolvedValue(contract);
    (contractService as any).providerAccount = PROVIDER_ACCOUNT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    contract.get_nonce.mockResolvedValue({ decodedResult: NONCE });
    contract.get_nonce_principal.mockResolvedValue({ decodedResult: NONCE });
    contract.get_link.mockResolvedValue({ decodedResult: 'hero.chain' });
    for (const write of [
      'link',
      'unlink',
      'link_principal',
      'unlink_principal',
    ]) {
      contract[write].mockResolvedValue({ hash: `th_${write}` });
    }
    oauthService.exchangeXCodeForAccessToken.mockResolvedValue('x-token');
    oauthService.verifyAccessToken.mockResolvedValue({
      id: '42',
      name: 'Alice',
      email: '',
      provider: 'x',
      username: 'Alice_X',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(`/address-links/${path}`).send(body);

  const expectNoWrite = () => {
    for (const write of [
      'link',
      'unlink',
      'link_principal',
      'unlink_principal',
    ]) {
      expect(contract[write]).not.toHaveBeenCalled();
    }
  };

  const claimFor = async (flow: LinkFlow): Promise<Claim> =>
    (await post(`${flow.path}/claim`, flow.claim).expect(201)).body;

  describe.each(Object.entries(flows))('%s', (_, flow) => {
    it('claim returns the message the wallet signs and writes nothing', async () => {
      const claim = await claimFor(flow);

      expect(claim.message).toBe(flow.message);
      expect(claim.nonce).toBe(NONCE);
      expectNoWrite();
    });

    it('submit sends that link from the provider wallet', async () => {
      const claim = await claimFor(flow);

      const res = await post(`${flow.path}/submit`, flow.submit(claim)).expect(
        201,
      );

      expect(res.body).toEqual({ txHash: `th_${flow.entrypoint}` });
      expect(contract[flow.entrypoint]).toHaveBeenCalledTimes(1);
      expect(contract[flow.entrypoint]).toHaveBeenCalledWith(
        ...flow.linked,
        ...SIGNED_BY_PROVIDER,
      );
    });

    it("refuses another address's submit before the contract", async () => {
      const claim = await claimFor(flow);

      await post(`${flow.path}/submit`, {
        ...flow.submit(claim),
        address: OTHER_ADDRESS,
      }).expect(400);
      expectNoWrite();
    });
  });

  describe('ownership proofs', () => {
    it('binds an X submit to the handle X returned', async () => {
      const claim = await claimFor(flows.x);

      await post('x/submit', {
        ...flows.x.submit(claim),
        value: 'elon',
      }).expect(400);
      expectNoWrite();
    });

    it('does not take a bio token as proof of an X handle', async () => {
      const bio = await claimFor({
        ...flows.bio,
        claim: { address: ADDRESS, value: 'alice_x' },
      });

      await post('x/submit', {
        ...flows.x.submit(bio),
        value: 'alice_x',
      }).expect(400);
      expectNoWrite();
    });

    it('refuses a Nostr proof signed by a key other than the npub', async () => {
      const claim = await claimFor(flows.nostr);

      await post('nostr/submit', {
        ...flows.nostr.submit(claim),
        nostr_event: nostrProof(claim.message, generateSecretKey()),
      }).expect(400);
      expectNoWrite();
    });

    it.each([
      ['no code', { x_code: undefined }],
      ['no code verifier', { x_code_verifier: undefined }],
      ['no redirect uri', { x_redirect_uri: undefined }],
      [
        'no credentials',
        {
          x_code: undefined,
          x_code_verifier: undefined,
          x_redirect_uri: undefined,
        },
      ],
    ])('refuses an X claim with %s without calling X', async (_, change) => {
      await post('x/claim', { ...flows.x.claim, ...change }).expect(400);

      expect(oauthService.exchangeXCodeForAccessToken).not.toHaveBeenCalled();
      expect(oauthService.verifyAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('unlink', () => {
    it.each(['x', 'nostr', 'bio', 'site'])(
      '%s signs and sends an unlink for its own provider',
      async (provider) => {
        const claim = await post(`${provider}/unclaim`, {
          address: ADDRESS,
        }).expect(201);
        expect(claim.body).toEqual({
          message: `unlink:${ADDRESS}:${provider}:${NONCE}`,
          nonce: NONCE,
        });
        expectNoWrite();

        const res = await post(`${provider}/unclaim/submit`, {
          address: ADDRESS,
          ...signed,
        }).expect(201);

        expect(res.body).toEqual({ txHash: 'th_unlink' });
        expect(contract.unlink).toHaveBeenCalledWith(
          ADDRESS,
          provider,
          NONCE,
          ...SIGNED_BY_PROVIDER,
        );
      },
    );

    it('preferred name signs the unlink for the linked name', async () => {
      const claim = await post('prefered-aens-name/unclaim', {
        address: ADDRESS,
      }).expect(201);
      expect(contract.get_link).toHaveBeenCalledWith(ADDRESS, 'prefaens');
      expect(claim.body).toEqual({
        message: `unlink:hero.chain:prefaens:${NONCE}`,
        nonce: NONCE,
        value: 'hero.chain',
        principal: 'hero.chain',
      });

      await post('prefered-aens-name/unclaim/submit', {
        address: ADDRESS,
        value: 'Hero.chain',
        ...signed,
      }).expect(201);

      expect(contract.unlink_principal).toHaveBeenCalledWith(
        'hero.chain',
        ADDRESS,
        'prefaens',
        NONCE,
        ...SIGNED_BY_PROVIDER,
      );
    });

    it('preferred name unclaim without a link is a 400', async () => {
      contract.get_link.mockResolvedValue({ decodedResult: false });

      await post('prefered-aens-name/unclaim', { address: ADDRESS }).expect(
        400,
      );
    });
  });

  describe('contract failures', () => {
    it('refuses a signature that is not 64 bytes of hex', async () => {
      await post('x/unclaim/submit', {
        address: ADDRESS,
        nonce: NONCE,
        signature: 'ab'.repeat(32),
      }).expect(400);
      expectNoWrite();
    });

    it('answers 400 with the reason when the contract rejects the signature', async () => {
      contract.unlink.mockRejectedValue(
        new Error('Invocation failed: "INVALID_SIGNATURE"'),
      );

      const res = await post('bio/unclaim/submit', {
        address: ADDRESS,
        ...signed,
      }).expect(400);

      expect(res.body.message).toContain(
        'Wallet signature verification failed',
      );
    });
  });

  describe('request validation', () => {
    it.each(routes)('%s refuses a malformed address', async (path, body) => {
      const res = await post(path, { ...body, address: 'ak_notanaddress' });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual([
        'address must be a valid account address',
      ]);
      expectNoWrite();
    });

    it.each(routes)('%s refuses a provider field', async (path, body) => {
      const res = await post(path, { ...body, provider: 'nostr' });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(['property provider should not exist']);
      expectNoWrite();
    });

    it.each(routes.filter(([path]) => path.endsWith('submit')))(
      '%s refuses a nonce sent as a string',
      async (path, body) => {
        const res = await post(path, { ...body, nonce: String(NONCE) });

        expect(res.status).toBe(400);
        expect(res.body.message).toEqual([expect.stringContaining('nonce')]);
        expectNoWrite();
      },
    );
  });
});
