import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { CommunityFactory, initCommunityFactory } from 'bctsl-sdk';
import { ACTIVE_NETWORK, BCL_FACTORY } from '@/configs';
import { ICommunityFactorySchema } from '@/utils/types';
import { AeSdkService } from './ae-sdk.service';

@Injectable()
export class CommunityFactoryService {
  cachedFactorySchema: Record<
    Encoded.ContractAddress,
    ICommunityFactorySchema
  > = {};
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
   * If the factory's collections are not already populated, it loads the token gating factory
   * and populates the collections from the collection registry.
   *
   * @returns {Promise<ICommunityFactorySchema>} A promise that resolves to the factory schema.
   */
  async getCurrentFactory(): Promise<ICommunityFactorySchema> {
    const factory = BCL_FACTORY[ACTIVE_NETWORK.networkId];

    if (this.cachedFactorySchema[factory.address]) {
      return this.cachedFactorySchema[factory.address];
    }

    if (!Object.keys(factory.collections).length) {
      const factoryInstance = await this.loadFactory(factory.address);
      const collection_registry: any = await factoryInstance.contract
        .get_state()
        .then((res) => res.decodedResult?.collection_registry);
      if (collection_registry) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        for (const [collectionName, collection] of Array.from(
          collection_registry as any,
        )) {
          const name = collectionName?.split('-ak_')[0];
          const allowed_name_length = collection.allowed_name_length?.toString();
          factory.collections[collectionName] = {
            id: collectionName,
            name,
            allowed_name_length,
            allowed_name_chars: collection.allowed_name_chars.map((rule) =>
              Object.fromEntries(
                Object.entries(rule).map(([key, chars]) => [
                  key,
                  (chars as string[]).map((char) => Number(char.toString())),
                ]),
              ),
            ),
            description: `Tokenize a unique name with up to ${allowed_name_length}.`,
          };
        }
      }
    }

    this.cachedFactorySchema[factory.address] = factory;

    return factory;
  }
}
