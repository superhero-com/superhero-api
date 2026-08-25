import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { CommunityFactory, initCommunityFactory } from 'bctsl-sdk';
import { ACTIVE_NETWORK, BCL_FACTORY } from '@/configs';
import { ICollectionInfo, ICommunityFactorySchema } from '@/utils/types';
import { AeSdkService } from './ae-sdk.service';

@Injectable()
export class CommunityFactoryService {
  cachedFactorySchema: Record<
    Encoded.ContractAddress,
    ICommunityFactorySchema
  > = {};
  factories: Record<Encoded.ContractAddress, CommunityFactory> = {};

  // Share the in-flight chain round-trip between concurrent cold callers;
  // rejections are evicted so a failed load doesn't poison retries.
  private inFlightFactories: Partial<
    Record<Encoded.ContractAddress, Promise<CommunityFactory>>
  > = {};
  private inFlightSchemas: Partial<
    Record<Encoded.ContractAddress, Promise<ICommunityFactorySchema>>
  > = {};

  constructor(private aeSdkService: AeSdkService) {
    //
  }

  async loadFactory(
    address: Encoded.ContractAddress,
  ): Promise<CommunityFactory> {
    if (!address) {
      address = BCL_FACTORY[ACTIVE_NETWORK.networkId].address;
    }
    if (this.factories[address]) {
      return this.factories[address];
    }

    const inFlight = this.inFlightFactories[address];
    if (inFlight) {
      return inFlight;
    }

    const pending = initCommunityFactory(this.aeSdkService.sdk as any, address)
      .then((factory) => {
        this.factories[address] = factory;
        return factory;
      })
      .finally(() => {
        delete this.inFlightFactories[address];
      });
    this.inFlightFactories[address] = pending;

    return pending;
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

    const inFlight = this.inFlightSchemas[factory.address];
    if (inFlight) {
      return inFlight;
    }

    const pending = this.buildFactorySchema(factory).finally(() => {
      delete this.inFlightSchemas[factory.address];
    });
    this.inFlightSchemas[factory.address] = pending;

    return pending;
  }

  private async buildFactorySchema(
    factory: ICommunityFactorySchema,
  ): Promise<ICommunityFactorySchema> {
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
          const allowed_name_length =
            collection.allowed_name_length?.toString();
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

  /**
   * Maps a token's stored collection id (the "<NAME>-ak_<deployer>" string) to
   * its trimmed collection metadata using an already-loaded factory schema.
   * Returns null when the token has no collection or the collection is unknown.
   * Prefer this over {@link getCollectionInfo} when enriching many items — load
   * the factory once and reuse it instead of awaiting per item.
   */
  mapCollectionInfo(
    factory: ICommunityFactorySchema,
    collectionId?: string | null,
  ): ICollectionInfo | null {
    const collection = collectionId
      ? factory.collections?.[collectionId]
      : undefined;
    if (!collection) {
      return null;
    }
    return {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      allowed_name_length: collection.allowed_name_length,
    };
  }

  /**
   * Resolves the trimmed collection metadata for a single collection id.
   * Returns null when the id is empty or unknown to the current factory.
   */
  async getCollectionInfo(
    collectionId?: string | null,
  ): Promise<ICollectionInfo | null> {
    if (!collectionId) {
      return null;
    }
    const factory = await this.getCurrentFactory();
    return this.mapCollectionInfo(factory, collectionId);
  }
}
