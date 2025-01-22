import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { BCL_FACTORY } from 'src/configs';
import { CommunityFactory, initCommunityFactory } from 'bctsl-sdk';
import { AeSdkService } from './ae-sdk.service';
import { ACTIVE_NETWORK } from './utils/networks';
import { IFactorySchema } from './utils/types';

@Injectable()
export class CommunityFactoryService {
  factories: Record<Encoded.ContractAddress, CommunityFactory> = {};
  constructor(private aeSdkService: AeSdkService) {
    //
  }

  async loadFactory(
    address: Encoded.ContractAddress,
  ): Promise<CommunityFactory> {
    if (this.factories[address]) {
      return this.factories[address];
    }

    const factory = await initCommunityFactory(this.aeSdkService.sdk, address);

    this.factories[address] = factory;

    return factory;
  }

  /**
   * Retrieves the current factory configuration for the active network.
   * If the factory's categories are not already populated, it loads the token gating factory
   * and populates the categories from the collection registry.
   *
   * @returns {Promise<IFactorySchema>} A promise that resolves to the factory schema.
   */
  async getCurrentFactory(): Promise<IFactorySchema> {
    const factory = BCL_FACTORY[ACTIVE_NETWORK.networkId];

    if (!Object.keys(factory.categories).length) {
      const factoryInstance = await this.loadFactory(factory.address);
      const collection_registry: any = await factoryInstance.contract
        .get_state()
        .then((res) => res.decodedResult?.collection_registry);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      for (const [categoryName, category] of Array.from(
        collection_registry as any,
      )) {
        const name = categoryName?.split('-ak_')[0];
        factory.categories[categoryName] = {
          name,
          allowed_name_length: category.allowed_name_length?.toString(),
        };
      }
    }

    return factory;
  }
}
