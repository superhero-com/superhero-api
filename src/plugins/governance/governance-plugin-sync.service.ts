import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { serializeBigInts } from '@/utils/common';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { getContractAddress } from './config/governance.config';
import GovernancePollACI from './contract/aci/GovernancePollACI.json';
import GovernanceRegistryACI from './contract/aci/GovernanceRegistryACI.json';
import { GovernancePlugin } from './governance.plugin';

@Injectable()
export class GovernancePluginSyncService extends BasePluginSyncService implements OnModuleInit {
  protected readonly logger = new Logger(GovernancePluginSyncService.name);
  contractAddress: Encoded.ContractAddress;
  contracts: Record<
    Encoded.ContractAddress,
    ContractWithMethods<ContractMethodsBase>
  > = {};

  constructor(
    private aeSdkService: AeSdkService,
    private readonly configService: ConfigService,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {
    super()
  }

  async onModuleInit(): Promise<void> {
    const config = this.configService.get<{ contract: { contractAddress: string } }>(
      'governance',
    );
    this.contractAddress = (config?.contract?.contractAddress ?? getContractAddress()) as Encoded.ContractAddress;
  }

  async getContract(contractAddress: Encoded.ContractAddress, aci: any = GovernanceRegistryACI): Promise<ContractWithMethods<ContractMethodsBase>> {
    if (this.contracts[contractAddress]) {
      return this.contracts[contractAddress];
    }
    const contract = await this.aeSdkService.sdk.initializeContract({
      aci,
      address: contractAddress as Encoded.ContractAddress,
    });
    this.contracts[contractAddress] = contract;
    return contract;
  }

  async processTransaction(tx: Tx, syncDirection: SyncDirection): Promise<void> {
    try {
      // Basic implementation - will be expanded once contract is debugged
      this.logger.debug('Processing governance transaction', {
        txHash: tx.hash,
        contractId: tx.contract_id,
        function: tx.function,
        syncDirection,
      });

      // TODO: Implement transaction processing logic based on contract functions
      // This will be expanded once the contract structure is understood
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }

  async decodeLogs(tx: Tx): Promise<any | null> {
    if (!tx?.raw?.log) {
      return null;
    }

    if (tx.function == 'add_poll') {
      try {
        const contract = await this.getContract(this.contractAddress);
        const decodedLogs = contract.$decodeEvents(tx.raw.log);

        return serializeBigInts(decodedLogs);
      } catch (error: any) {
        this.logger.error(
          `Failed to decode logs for transaction ${tx.hash}`,
          error.stack,
        );
        return null;
      }
    }

    if (['vote', 'revoke_vote'].includes(tx.function)) {
      try {
        const contract = await this.getContract(
          tx.contract_id as Encoded.ContractAddress,
          GovernancePollACI,
        );
        const decodedLogs = contract.$decodeEvents(tx.raw.log);

        return serializeBigInts(decodedLogs);
      } catch (error: any) {
        this.logger.error(
          `Failed to decode logs for transaction ${tx.hash}`,
          error.stack,
        );
        return null;
      }
    }


    return null;
  }

  async decodeData(tx: Tx): Promise<any | null> {
    const pluginLogs = tx.logs?.[GovernancePlugin.name];
    if (!pluginLogs?.data?.length) {
      return null;
    }

    if (tx.function == 'add_poll') {
      const decodedLogs = pluginLogs.data[0];

      const pollAddress = decodedLogs.args[0];
      // find this contract create tx 'ContractCreateTx'
      const createTx = await this.txRepository.findOne({
        where: {
          type: 'ContractCreateTx',
          contract_id: pollAddress as Encoded.ContractAddress,
        },
      });
      const contractCreateTxArgs = createTx?.raw?.args;
      const metadataArgs = contractCreateTxArgs[0]?.value
      const voteOptionsArgs = contractCreateTxArgs[1]?.value
      const closeHeightArgs = contractCreateTxArgs[2]?.value
      return {
        metadata: {
          title: metadataArgs[0],
          description: metadataArgs[1],
          link: metadataArgs[2],
          _spec_ref: metadataArgs[3],
        },
        vote_options: voteOptionsArgs,
        author: createTx?.caller_id,
        poll_address: pollAddress,
        poll_seq_id: decodedLogs.args[1],
        close_at_height: closeHeightArgs[0],
        close_height: closeHeightArgs[1],
        create_height: createTx?.block_height,
      };
    }

    if (tx.function == 'vote') {
      const decodedLogs = pluginLogs.data[0];
      return {
        poll_address: decodedLogs.contract.address,
        poll: decodedLogs.args[0],
        voter: decodedLogs.args[1],
        option: Number(decodedLogs.args[2]),
      };
    }


    return null;
  }
}

