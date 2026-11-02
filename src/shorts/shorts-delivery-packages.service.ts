import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  PlaybackDescriptor,
  deliverySourceIdentity,
} from './hls-protocol/playback-descriptor';
import {
  HlsPackage,
  sourceKey,
  validateSourcePackage,
} from './hls-protocol/hls-package';

/** Metadata only. An acknowledgement is neither serving permission nor deletion authority. */
@Injectable()
export class ShortsDeliveryPackagesService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  private identity(descriptor: PlaybackDescriptor) {
    return [
      descriptor.network,
      descriptor.contract,
      descriptor.id,
      sourceKey(descriptor),
      deliverySourceIdentity(descriptor),
    ];
  }
  async acknowledge(
    descriptor: PlaybackDescriptor,
    value: HlsPackage,
    pinOperation?: string,
  ) {
    const prepared = validateSourcePackage(descriptor, value);
    const args = this.identity(descriptor);
    await this.db.transaction(async (db) => {
      const [saved] = await db.query(
        `SELECT prepared=$5::jsonb AS matches FROM shorts_delivery_packages
        WHERE network=$1 AND contract=$2 AND short_id=$3 AND source_key=$4`,
        [...args.slice(0, 4), JSON.stringify(prepared)],
      );
      if (saved) {
        if (!saved.matches)
          throw new ConflictException(
            'A different delivery package was already acknowledged',
          );
      }
      if (
        (process.env.SHORTS_IPFS_EXPIRING_WRITES === 'true' && !saved) ||
        pinOperation
      ) {
        if (
          !pinOperation ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            pinOperation,
          )
        )
          throw new ConflictException('Delivery requires fresh pin authority');
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||$1,0))",
          [prepared.cid],
        );
        const [pin] = await db.query(
          `SELECT operation_id FROM shorts_pin_transfers
          WHERE operation_id=$1 AND cid=$2 AND network=$3 AND contract=$4 AND job_id=$5 AND source_key=$6
          AND purpose='hls' AND state='issued' AND expires_at>clock_timestamp()`,
          [
            pinOperation,
            prepared.cid,
            descriptor.network,
            descriptor.contract,
            descriptor.id,
            args[3],
          ],
        );
        if (!pin)
          throw new ConflictException(
            'Delivery pin authority expired or changed',
          );
      }
      await db.query(
        `INSERT INTO shorts_delivery_packages(network,contract,short_id,source_key,source_identity,prepared)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [...args, JSON.stringify(prepared)],
      );
      const [row] = await db.query(
        `SELECT source_identity=$5 AS source_matches,prepared=$6::jsonb AS package_matches
        FROM shorts_delivery_packages WHERE network=$1 AND contract=$2 AND short_id=$3 AND source_key=$4`,
        [...args, JSON.stringify(prepared)],
      );
      if (!row?.source_matches || !row.package_matches)
        throw new ConflictException(
          'A different delivery package was already acknowledged',
        );
      if (pinOperation)
        await db.query(
          "UPDATE shorts_pin_transfers SET state='pinned' WHERE operation_id=$1",
          [pinOperation],
        );
    });
  }
  async get(descriptor: PlaybackDescriptor): Promise<HlsPackage | undefined> {
    const [row] = await this.db.query(
      `SELECT source_identity,prepared FROM shorts_delivery_packages
      WHERE network=$1 AND contract=$2 AND short_id=$3 AND source_key=$4`,
      this.identity(descriptor).slice(0, 4),
    );
    if (!row) return undefined;
    if (row.source_identity !== deliverySourceIdentity(descriptor))
      throw new ConflictException('Delivery source identity changed');
    return validateSourcePackage(descriptor, row.prepared);
  }
}
