import { profileImageReference } from './image-reference';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  buildTxHash,
  buildContractIdByContractTx,
  unpackTx,
  Tag,
  Contract,
  Encoded,
  AccountMemory,
  Node,
} from '@aeternity/aepp-sdk';
import { publisherTransport } from '../shorts/shorts-publisher-node.service';
import aci from '../plugins/address-links/aci/AddressLink.aci.json';
import {
  ImageRole,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
  profileMediaSecret,
} from './profile-media.config';

class JournalAccount extends AccountMemory {
  constructor(
    key: Encoded.AccountSecretKey,
    private readonly journal: (tx: Encoded.Transaction) => Promise<void>,
  ) {
    super(key);
  }
  override async signTransaction(
    tx: Encoded.Transaction,
    options?: Parameters<AccountMemory['signTransaction']>[1],
  ) {
    const signed = await super.signTransaction(tx, options);
    // Persist before the SDK can broadcast, including on an ambiguous timeout.
    await this.journal(signed);
    return signed;
  }
}

@Injectable()
export class ProfileMediaChain implements OnModuleInit {
  private node!: Node;
  private activeReads = 0;
  private readonly waitingReads: Array<() => void> = [];
  private contract: any;
  private account!: AccountMemory;
  constructor(
    @Inject(PROFILE_MEDIA_CONFIG) readonly config: ProfileMediaConfig,
  ) {}
  async onModuleInit() {
    if (!this.config.enabled) return;
    this.node = new Node(this.config.node, {
      retryCount: 0,
      httpClient: publisherTransport(this.config.node),
    });
    if ((await this.node.getNetworkId()) !== this.config.network)
      throw new Error('Profile media node network mismatch');
    try {
      this.account = new AccountMemory(
        (await profileMediaSecret(
          this.config.providerKeyFile,
        )) as Encoded.AccountSecretKey,
      );
    } catch {
      throw new Error('Profile media provider credential is unavailable');
    }
    this.contract = await Contract.initialize({
      aci: aci as any,
      address: this.config.contract,
      onNode: this.node,
    });
  }
  get providerAddress() {
    return this.account.address;
  }
  async providers() {
    const owners: Record<string, string | null> = {};
    for (const role of ['avatar', 'cover'])
      owners[role] =
        (await this.contract.get_provider_owner(role)).decodedResult ?? null;
    return owners;
  }
  async ensureProviders(register = false) {
    const owners = await this.providers();
    for (const role of ['avatar', 'cover']) {
      if (owners[role] && owners[role] !== this.providerAddress)
        throw new Error(`The ${role} provider belongs to another wallet`);
      if (!owners[role]) {
        if (!register)
          throw new Error(`The ${role} provider is not registered`);
        await this.contract.register_provider(role, {
          onAccount: this.account,
          waitMined: true,
        });
      }
    }
    return this.providers();
  }
  async deploy(
    bytecode: Encoded.ContractBytearray,
    journal: (record: {
      address: string;
      txHash: string;
      signedTx: string;
    }) => Promise<void>,
  ): Promise<void> {
    // Only the journal is authoritative after an ambiguous deployment response.
    if (this.config.network !== 'ae_uat')
      throw new Error('Profile setup deployment is restricted to testnet');
    const contract = await Contract.initialize({
      aci: aci as any,
      bytecode,
      onNode: this.node,
    });
    const onAccount = new JournalAccount(
      this.account.secretKey,
      async (signedTx) => {
        await journal({
          address: buildContractIdByContractTx(signedTx),
          txHash: buildTxHash(signedTx),
          signedTx,
        });
      },
    );
    await contract.$deploy([], { onAccount, waitMined: false });
  }
  private async read<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeReads < 4) this.activeReads += 1;
    else {
      if (this.waitingReads.length >= 64)
        throw new ServiceUnavailableException('Profile image reads are busy');
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waitingReads.indexOf(ready);
          if (index >= 0) this.waitingReads.splice(index, 1);
          reject(
            new ServiceUnavailableException('Profile image reads are busy'),
          );
        }, 6000);
        this.waitingReads.push(ready);
      });
    }
    try {
      return await work();
    } finally {
      const next = this.waitingReads.shift();
      if (next) next();
      else this.activeReads -= 1;
    }
  }
  async links(address: string): Promise<Record<string, string>> {
    return this.read(async () => {
      const result = (await this.contract.get_links(address)).decodedResult;
      return result instanceof Map ? Object.fromEntries(result) : result || {};
    });
  }
  async nonce(address: string): Promise<number> {
    const value = Number(
      (await this.contract.get_nonce(address)).decodedResult,
    );
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ServiceUnavailableException('Invalid identity nonce');
    return value;
  }
  message(address: string, role: ImageRole, nonce: number, cid: string | null) {
    return cid
      ? `link:${address}:${role}:${profileImageReference(cid)}:${nonce}`
      : `unlink:${address}:${role}:${nonce}`;
  }
  async submit(
    address: string,
    role: ImageRole,
    nonce: number,
    value: string | null,
    signature: string,
    journal: (tx: string, hash: string) => Promise<void>,
  ) {
    if ((await this.nonce(address)) !== nonce)
      throw new ConflictException(
        'Your profile changed. Please review and sign again.',
      );
    const height = (await this.node.getCurrentKeyBlockHeight()).height;
    const onAccount = new JournalAccount(this.account.secretKey, (tx) =>
      journal(tx, buildTxHash(tx)),
    );
    const args = value
      ? [address, role, value, nonce, Buffer.from(signature, 'hex')]
      : [address, role, nonce, Buffer.from(signature, 'hex')];
    try {
      return await this.contract.$call(value ? 'link' : 'unlink', args, {
        onAccount,
        waitMined: false,
        absoluteTtl: true,
        ttl: height + 20,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        [
          'INVALID_NONCE',
          'INVALID_SIGNATURE',
          'ALREADY_CLAIMED',
          'NOT_PROVIDER_OWNER',
          'LINK_NOT_FOUND',
          'NO_LINKS',
        ].some((v) => message.includes(v))
      )
        throw new BadRequestException(
          'The image change could not be applied. Refresh your profile and try again.',
        );
      throw new ServiceUnavailableException(
        'The transaction is being checked. Keep its pending status before retrying.',
      );
    }
  }
  async transaction(
    hash: string,
  ): Promise<'pending' | 'confirmed' | 'failed' | 'missing'> {
    try {
      const tx = await this.node.getTransactionByHash(hash);
      if (tx.blockHeight < 0) return 'pending';
      const info = await this.node.getTransactionInfoByHash(hash);
      if (!info.callInfo) return 'pending';
      return info.callInfo.returnType === 'ok' ? 'confirmed' : 'failed';
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404)
        return 'missing';
      throw new ServiceUnavailableException(
        'Unable to check the image transaction',
      );
    }
  }
  async expired(tx: string) {
    const signed = unpackTx(tx as Encoded.Transaction, Tag.SignedTx) as any;
    const call = signed.encodedTx;
    if (call.tag !== Tag.ContractCallTx)
      throw new Error('Invalid image transaction journal');
    return (
      (await this.node.getCurrentKeyBlockHeight()).height > Number(call.ttl) + 3
    );
  }
  async rebroadcast(tx: string) {
    await this.node.postTransaction({ tx });
  }
}
