import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { serializeBigInts } from '@/utils/common';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { GOVERNANCE_CONTRACT } from './config/governance.config';
import GovernancePollACI from './contract/aci/GovernancePollACI.json';
import GovernanceRegistryACI from './contract/aci/GovernanceRegistryACI.json';

@Injectable()
export class GovernancePluginSyncService extends BasePluginSyncService implements OnModuleInit {
  protected readonly logger = new Logger(GovernancePluginSyncService.name);
  readonly pluginName = 'governance';
  contracts: Record<
    Encoded.ContractAddress,
    ContractWithMethods<ContractMethodsBase>
  > = {};

  constructor(
    private aeSdkService: AeSdkService,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {
    super()
  }

  async onModuleInit(): Promise<void> {
    //
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

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.add_poll) {
      try {
        const contract = await this.getContract(GOVERNANCE_CONTRACT.contractAddress);
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

    if ([GOVERNANCE_CONTRACT.FUNCTIONS.vote, GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote].includes(tx.function)) {
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
    const pluginLogs = tx.logs?.[this.pluginName];
    if (!pluginLogs?.data?.length) {
      return null;
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.add_poll) {
      const decodedLogs = pluginLogs.data[0];

      const pollAddress = decodedLogs.args[0];
      // find this contract create tx 'ContractCreateTx'
      const createTx = await this.txRepository.findOne({
        where: {
          type: 'ContractCreateTx',
          contract_id: pollAddress as Encoded.ContractAddress,
        },
      });

      if (!createTx) {
        this.logger.warn(
          `ContractCreateTx not found for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      const contractCreateTxArgs = createTx.raw?.args;
      if (!contractCreateTxArgs || !Array.isArray(contractCreateTxArgs)) {
        this.logger.warn(
          `Invalid contract create tx args for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      const metadataArgs = contractCreateTxArgs[0]?.value;
      const voteOptionsArgs = contractCreateTxArgs[1]?.value;
      const closeHeightArgs = contractCreateTxArgs[2]?.value;

      if (!metadataArgs || !Array.isArray(metadataArgs)) {
        this.logger.warn(
          `Invalid metadata args for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      return {
        metadata: {
          title: metadataArgs[0],
          description: metadataArgs[1],
          link: metadataArgs[2],
          _spec_ref: metadataArgs[3],
        },
        vote_options: voteOptionsArgs,
        author: createTx.caller_id,
        poll_address: pollAddress,
        poll_seq_id: decodedLogs.args[1],
        close_at_height: closeHeightArgs?.[0],
        close_height: closeHeightArgs?.[1],
        create_height: createTx.block_height,
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.vote) {
      const decodedLogs = pluginLogs.data[0];
      return {
        poll_address: decodedLogs.contract.address,
        poll: decodedLogs.args[0],
        voter: decodedLogs.args[1],
        option: Number(decodedLogs.args[2]),
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote) {
      const decodedLogs = pluginLogs.data[0];
      return {
        poll_address: decodedLogs.contract.address,
        poll: decodedLogs.args[0],
        voter: decodedLogs.args[1],
      };
    }

    return null;
  }
}

