import { Contract, Node } from '@aeternity/aepp-sdk';
import aci from '../aci/SocialContractV2.aci.json';
import { normalizeEventTopics } from '@/utils/common';
import { decimal } from './social-graph-v2-reader';

export function contractAddress(address: string): string {
  // Address and contract IDs encode the same 32-byte payload and checksum.
  return address.replace(/^ak_/, 'ct_');
}
export interface MigrationEvidence {
  sourceCutoff: string | null;
  activationHeight: string | null;
  proof: Record<string, unknown> | null;
}
export interface MigrationEvidenceOptions {
  activationTx?: string;
  freezeTx?: string;
  legacySnapshotHash?: string;
  legacyManifestHash?: string;
}

/** Verifies configured receipts; it never infers a cutoff from the API snapshot. */
export class SocialGraphV2Lifecycle {
  constructor(private readonly node: Node) {}

  async receipt(
    txHash: string,
    contract: string,
  ): Promise<{
    txHash: string;
    height: string;
    blockHash: string;
    keyBlockHash: string;
    events: { name: string; args: unknown[] }[];
  }> {
    if (!/^th_[1-9A-HJ-NP-Za-km-z]+$/.test(txHash))
      throw new Error('Invalid migration transaction hash');
    const tx = await this.node.getTransactionByHash(txHash);
    const height = decimal(tx.blockHeight);
    const generation = await this.node.getGenerationByHeight(Number(height));
    if (!generation.microBlocks.includes(tx.blockHash))
      throw new Error('Migration receipt is not canonical');
    let info: any = await this.node.getTransactionInfoByHash(txHash);
    for (let depth = 0; info.gaInfo; depth++) {
      if (
        depth >= 32 ||
        info.gaInfo.returnType !== 'ok' ||
        !info.gaInfo.innerObject
      )
        throw new Error('Migration wrapper did not succeed');
      info = info.gaInfo.innerObject;
    }
    if (info.callInfo?.returnType !== 'ok')
      throw new Error('Migration call did not succeed');
    const decoder = await Contract.initialize({
      onNode: this.node,
      address: contract as any,
      aci,
    });
    const events = decoder.$decodeEvents(
      normalizeEventTopics(
        info.callInfo.log.filter((log) => log.address === contract),
      ),
    );
    return {
      txHash,
      height,
      blockHash: tx.blockHash,
      keyBlockHash: generation.keyBlock.hash,
      events,
    };
  }

  async verify(
    policy: {
      contract: string;
      height: string;
      import_source: string | null;
      legacy_source: string | null;
      block_hash: string;
    },
    options: MigrationEvidenceOptions,
  ): Promise<MigrationEvidence> {
    const source = policy.import_source || policy.legacy_source;
    if (!source)
      return { sourceCutoff: null, activationHeight: null, proof: null };
    if (!options.activationTx)
      throw new Error(
        'Migrated V2 contract requires SOCIAL_GRAPH_V2_ACTIVATION_TX',
      );
    const activation = await this.receipt(
      options.activationTx,
      policy.contract,
    );
    if (
      BigInt(activation.height) >= BigInt(policy.height) ||
      !activation.events.some(
        (e) =>
          e.name === 'ImportCompleted' &&
          contractAddress(String(e.args[0])) === contractAddress(source),
      )
    )
      throw new Error(
        'Destination activation evidence does not match snapshot source',
      );
    if (policy.import_source) {
      if (!options.freezeTx)
        throw new Error(
          'Frozen-source migration requires SOCIAL_GRAPH_V2_SOURCE_FREEZE_TX',
        );
      const freeze = await this.receipt(
        options.freezeTx,
        contractAddress(source),
      );
      if (
        BigInt(freeze.height) > BigInt(activation.height) ||
        !freeze.events.some(
          (e) =>
            e.name === 'Frozen' &&
            contractAddress(String(e.args[0])) === policy.contract,
        )
      )
        throw new Error(
          'Source freeze evidence does not nominate this destination',
        );
      return {
        sourceCutoff: freeze.height,
        activationHeight: activation.height,
        proof: {
          kind: 'frozen-source',
          source: contractAddress(source),
          freeze_tx: freeze.txHash,
          freeze_block_hash: freeze.blockHash,
          activation_tx: activation.txHash,
          activation_block_hash: activation.blockHash,
        },
      };
    }
    if (
      !options.legacySnapshotHash ||
      !options.legacyManifestHash ||
      !/^[a-f0-9]{64}$/i.test(options.legacyManifestHash)
    )
      throw new Error(
        'Legacy migration requires an approved snapshot block and manifest digest',
      );
    const destination = await Contract.initialize({
      onNode: this.node,
      address: policy.contract as any,
      aci,
    });
    const progress = (
      await destination.get_import_progress({
        top: policy.block_hash,
        callStatic: true,
      })
    ).decodedResult as any;
    const commitment = Buffer.from(progress[4]).toString('hex');
    if (commitment.toLowerCase() !== options.legacyManifestHash.toLowerCase())
      throw new Error(
        'Legacy manifest commitment does not match activated destination',
      );
    const snapshot = await this.node.getKeyBlockByHash(
      options.legacySnapshotHash,
    );
    const canonical = await this.node.getKeyBlockByHeight(snapshot.height);
    if (
      canonical.hash !== snapshot.hash ||
      BigInt(snapshot.height) > BigInt(activation.height)
    )
      throw new Error('Invalid legacy snapshot boundary');
    return {
      sourceCutoff: decimal(snapshot.height),
      activationHeight: activation.height,
      proof: {
        kind: 'owner-approved-legacy',
        source: contractAddress(source),
        snapshot_hash: snapshot.hash,
        manifest_commitment: options.legacyManifestHash,
        activation_tx: activation.txHash,
        activation_block_hash: activation.blockHash,
        trust:
          'Operator-approved legacy snapshot; receipt proves activation, not legacy data truth.',
      },
    };
  }
}
