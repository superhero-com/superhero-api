import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema that predates migrations (production built it with `synchronize`),
 * so an empty database can run the rest. Frozen: schema changes go in new
 * migrations, and anything a later migration creates is left out of here.
 */
export class BaseSchema1718900000000 implements MigrationInterface {
  name = 'BaseSchema1718900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TypeORM runs pending migrations older than applied ones, so this also
    // runs on every existing database; it only acts on an empty one.
    const [{ empty }] = await queryRunner.query(
      `SELECT NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'migrations') AS empty`,
    );
    if (!empty) return;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "trending_tags" ("id" SERIAL NOT NULL, "tag" character varying NOT NULL, "description" character varying, "score" integer NOT NULL, "source" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_9ddeff182a0d664660072d99c4b" UNIQUE ("tag"), CONSTRAINT "PK_b029790a8c093dd5e09162b4098" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "token" ("sale_address" character varying NOT NULL, "unlisted" boolean NOT NULL DEFAULT false, "last_tx_hash" character varying, "last_sync_block_height" integer, "last_sync_tx_count" integer NOT NULL DEFAULT '0', "tx_count" integer NOT NULL DEFAULT '0', "holders_count" integer NOT NULL DEFAULT '0', "factory_address" character varying, "create_tx_hash" character varying, "dao_address" character varying, "creator_address" character varying, "beneficiary_address" character varying, "bonding_curve_address" character varying, "dao_balance" numeric NOT NULL DEFAULT 0, "owner_address" character varying, "address" character varying, "name" character varying NOT NULL, "symbol" character varying NOT NULL, "decimals" bigint NOT NULL DEFAULT '18', "collection" character varying, "price" numeric NOT NULL DEFAULT 0, "price_data" json, "sell_price" numeric NOT NULL DEFAULT 0, "sell_price_data" json, "market_cap" numeric NOT NULL DEFAULT 0, "market_cap_data" json, "total_supply" numeric NOT NULL DEFAULT 0, "trending_score" numeric(10,6) NOT NULL DEFAULT '0', "trending_score_update_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_43760758f537ecce1582f36e291" PRIMARY KEY ("sale_address"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d0e4c5069cc622e7742b244bea" ON "token" ("unlisted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_019704311a01878c1908815dbc" ON "token" ("factory_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ec978024d44e36d4469c29eac9" ON "token" ("creator_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_30153cf9c74eace3ba9711716f" ON "token" ("owner_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_40a4dcc6b727285c6539aa1d1c" ON "token" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dc9680c2bbb75483a58b9c4fc5" ON "token" ("name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e31c0ee2b8847dc76f3646ecc7" ON "token" ("symbol")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_97a58ef299251a326086aff409" ON "token" ("market_cap")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3c3785e9ee143e660264dec5a0" ON "token" ("trending_score")`,
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" ("tx_hash" character varying NOT NULL, "sale_address" character varying NOT NULL, "tx_type" character varying NOT NULL, "block_height" integer NOT NULL, "verified" boolean NOT NULL DEFAULT false, "address" character varying NOT NULL, "volume" numeric NOT NULL DEFAULT 0, "protocol_reward" numeric NOT NULL DEFAULT 0, "amount" json NOT NULL, "unit_price" json NOT NULL, "previous_buy_price" json, "buy_price" json NOT NULL, "sell_price" json, "total_supply" numeric NOT NULL DEFAULT 0, "market_cap" json, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_0deaa0ee5092d45fac99139de7c" PRIMARY KEY ("tx_hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0deaa0ee5092d45fac99139de7" ON "transactions" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0e7cd67503151b5ff27071be2e" ON "transactions" ("sale_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cde04d1ed3f8beb2df1e59e978" ON "transactions" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_450a5294dfde65588ff285fcff" ON "transactions" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_TRANSACTION_CREATED_AT_ADDRESS_TYPE" ON "transactions" ("created_at", "address", "tx_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_TRANSACTION_ADDRESS_BLOCK_HEIGHT" ON "transactions" ("address", "block_height")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_TRANSACTION_SALE_ADDRESS_BLOCK_HEIGHT_CREATED_AT" ON "transactions" ("sale_address", "block_height", "created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "token_eligibility_counts" ("symbol" character varying NOT NULL, "post_count" integer NOT NULL DEFAULT '0', "stored_post_count" integer NOT NULL DEFAULT '0', "content_post_count" integer NOT NULL DEFAULT '0', "refreshed_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_0027c0a85d86b48246fa4cd550b" PRIMARY KEY ("symbol"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "token_holder" ("id" character varying NOT NULL, "aex9_address" character varying NOT NULL, "address" character varying NOT NULL, "balance" numeric NOT NULL DEFAULT 0, "block_number" integer NOT NULL DEFAULT '0', "last_tx_hash" character varying NOT NULL DEFAULT '', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_c5e10d5c2543fac00a5d3086a2c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dda8f4682bc04aac8343901e18" ON "token_holder" ("aex9_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6b3c0be07f28745c01c39d1924" ON "token_holder" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ab9f5e96193ab254577f62af62" ON "token_holder" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "accounts" ("address" character varying NOT NULL, "bio" character varying, "chain_name" character varying, "chain_name_updated_at" TIMESTAMP, "total_volume" numeric NOT NULL DEFAULT 0, "total_tx_count" integer NOT NULL DEFAULT '0', "total_buy_tx_count" integer NOT NULL DEFAULT '0', "total_sell_tx_count" integer NOT NULL DEFAULT '0', "total_created_tokens" integer NOT NULL DEFAULT '0', "total_invitation_count" integer NOT NULL DEFAULT '0', "total_claimed_invitation_count" integer NOT NULL DEFAULT '0', "total_revoked_invitation_count" integer NOT NULL DEFAULT '0', "links" jsonb NOT NULL DEFAULT '{}', "banned" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_48ec5fcf335b99d4792dd5e4537" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "topics" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" character varying(500), "post_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "version" integer NOT NULL DEFAULT '0', "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_1304b1c61016e63f60cd147ce6b" UNIQUE ("name"), CONSTRAINT "PK_e4aa99a3fa60ec3a37d1fc4e853" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "posts" ("id" character varying NOT NULL, "post_id" character varying, "slug" character varying, "tx_hash" character varying NOT NULL, "tx_args" json NOT NULL, "sender_address" character varying NOT NULL, "contract_address" character varying NOT NULL, "type" character varying NOT NULL, "content" character varying NOT NULL, "token_mentions" jsonb NOT NULL DEFAULT '[]', "media" json NOT NULL DEFAULT '[]', "total_comments" integer NOT NULL, "is_hidden" boolean NOT NULL DEFAULT false, "version" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_f996b385ffd744354f4e3e62f51" UNIQUE ("tx_hash"), CONSTRAINT "PK_2829ac61eff60fcec60d7274b9e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_565d3e71ac2ea22a54a0631994" ON "posts" ("sender_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_POSTS_SENDER_ADDRESS_CREATED_AT" ON "posts" ("sender_address", "created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "tips" ("tx_hash" character varying NOT NULL, "type" character varying NOT NULL DEFAULT 'profile', "amount" character varying NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "sender_address" character varying, "receiver_address" character varying, "post_id" character varying, CONSTRAINT "PK_bab0f4e64c7094606e07638d1fb" PRIMARY KEY ("tx_hash"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "post_reads_daily" ("post_id" character varying NOT NULL, "date" date NOT NULL, "reads" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_1eea31c4233cb6d498d9e54179d" PRIMARY KEY ("post_id", "date"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "post_analytics" ("id" SERIAL NOT NULL, "date" date NOT NULL, "total_posts" integer NOT NULL DEFAULT '0', "total_comments" integer NOT NULL DEFAULT '0', "total_all" integer NOT NULL DEFAULT '0', "total_unique_posters" integer NOT NULL DEFAULT '0', "cumulative_total_posts" integer NOT NULL DEFAULT '0', "avg_comments_per_post" numeric(18,4) NOT NULL DEFAULT '0', CONSTRAINT "UQ_f7007ead25268def0871e3d9142" UNIQUE ("date"), CONSTRAINT "PK_421771f55c623cd4f6103828196" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_streak_bonus_rewards" ("id" SERIAL NOT NULL, "address" character varying NOT NULL, "x_user_id" character varying NOT NULL, "streak_length" integer NOT NULL DEFAULT '10', "streak_completed_day" date NOT NULL, "amount_aettos" character varying, "tx_hash" character varying, "status" character varying NOT NULL DEFAULT 'pending', "error" text, "retry_count" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "ux_profile_x_streak_bonus_completion" UNIQUE ("x_user_id", "streak_completed_day"), CONSTRAINT "PK_51bd46d45467a32866338cf0df7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_369a7664563cce7dbeea8c9001" ON "profile_x_streak_bonus_rewards" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b2900b66caf912a5d6a1744521" ON "profile_x_streak_bonus_rewards" ("x_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d9e209eb7ecdd44ed1198859c4" ON "profile_x_streak_bonus_rewards" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_posting_rewards" ("address" character varying NOT NULL, "x_username" character varying, "x_user_id" character varying, "rewarded_x_user_id" character varying, "qualified_posts_count" integer NOT NULL DEFAULT '0', "referral_code" character varying, "last_x_api_scan_at" TIMESTAMP, "follower_count" integer, "follower_tier_index" integer, "follower_snapshot_at" TIMESTAMP, "last_qualifying_post_day" date, "current_streak_days" integer NOT NULL DEFAULT '0', "x_lookup_failure_count" integer NOT NULL DEFAULT '0', "verified_at" TIMESTAMP, "last_scanned_tweet_id" character varying, "tx_hash" character varying, "status" character varying NOT NULL DEFAULT 'pending', "error" text, "retry_count" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP, "last_attempt_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_db97e1e458ed3e28cf41d236b50" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1c48b5f4657617fb6d273c3571" ON "profile_x_posting_rewards" ("x_username")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_91918dbbc4c2bef9759739730b" ON "profile_x_posting_rewards" ("x_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b65efc896f230e27b8ec69e1c9" ON "profile_x_posting_rewards" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_profile_x_posting_rewards_referral_code" ON "profile_x_posting_rewards" ("referral_code") WHERE referral_code IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_profile_x_posting_rewards_x_user_id" ON "profile_x_posting_rewards" ("x_user_id") WHERE x_user_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_invites" ("id" SERIAL NOT NULL, "inviter_address" character varying NOT NULL, "invitee_address" character varying, "code" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'active', "bound_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_311694d0888fc75f0b4ffa4b02c" UNIQUE ("invitee_address"), CONSTRAINT "UQ_5a35766885b8c6bb35ddb5ac4f7" UNIQUE ("code"), CONSTRAINT "PK_855c533fac0ded8ce8591c86c87" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ca98dbecadd361f7d96c335900" ON "profile_x_invites" ("inviter_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_311694d0888fc75f0b4ffa4b02" ON "profile_x_invites" ("invitee_address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_post_reward_ledger" ("id" SERIAL NOT NULL, "address" character varying NOT NULL, "x_user_id" character varying NOT NULL, "tweet_id" character varying NOT NULL, "tweet_created_at" TIMESTAMP, "tweet_utc_day" date, "reward_kind" character varying NOT NULL DEFAULT 'per_post', "amount_aettos" character varying, "follower_count_at_post" integer, "tier_index_at_post" integer, "tx_hash" character varying, "status" character varying NOT NULL DEFAULT 'pending', "error" text, "retry_count" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "ux_profile_x_post_reward_ledger_identity" UNIQUE ("x_user_id", "tweet_id"), CONSTRAINT "PK_c9ccd44561990a567ad924d6435" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eaa7277ee17d74aa56cf2c8c0f" ON "profile_x_post_reward_ledger" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5423c0f1072d35d9d3490c9268" ON "profile_x_post_reward_ledger" ("x_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cfae378f8c2c6144137ad796f6" ON "profile_x_post_reward_ledger" ("tweet_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4145f7435dcf31bf72c297bf0d" ON "profile_x_post_reward_ledger" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_profile_x_post_reward_ledger_day" ON "profile_x_post_reward_ledger" ("x_user_id", "tweet_utc_day") WHERE "tweet_utc_day" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_invite_milestone_rewards" ("id" SERIAL NOT NULL, "inviter_address" character varying NOT NULL, "threshold" integer NOT NULL DEFAULT '10', "tx_hash" character varying, "status" character varying NOT NULL DEFAULT 'pending', "error" text, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_88b9f272c9aa9627d92e09ea01b" UNIQUE ("inviter_address", "threshold"), CONSTRAINT "PK_e19dbd95f37c67ea9149e7fa33a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_94a57b629aeeec7a8d5c6d5d52" ON "profile_x_invite_milestone_rewards" ("inviter_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6a3d498cee2f409055db803e81" ON "profile_x_invite_milestone_rewards" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_chain_name_challenges" ("id" SERIAL NOT NULL, "nonce" character varying NOT NULL, "address" character varying NOT NULL, "expires_at" TIMESTAMP NOT NULL, "consumed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_76feb1c889e757d64ffb83bd7a0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b54729b05e248f3db495981f12" ON "profile_chain_name_challenges" ("nonce")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8f6e2abe7584d933705a836b45" ON "profile_chain_name_challenges" ("address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_invite_challenges" ("id" SERIAL NOT NULL, "nonce" character varying NOT NULL, "address" character varying NOT NULL, "purpose" character varying NOT NULL, "invite_code" character varying, "expires_at" TIMESTAMP NOT NULL, "consumed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_db7dbe339aca828e84f5821b6e5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f7b34200c6277d76082b755bf5" ON "profile_x_invite_challenges" ("nonce")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6cf1566d5a693d25a095c58069" ON "profile_x_invite_challenges" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6d300c88b62c3422b3da44de34" ON "profile_x_invite_challenges" ("invite_code")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_x_invite_credits" ("id" SERIAL NOT NULL, "inviter_address" character varying NOT NULL, "invitee_address" character varying NOT NULL, "invite_code" character varying NOT NULL, "verified_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_0eb7815c7df3ac0c7e081fa16c7" UNIQUE ("invitee_address"), CONSTRAINT "UQ_8ba5008d8fb2a78fdf46bfcc55b" UNIQUE ("inviter_address", "invitee_address"), CONSTRAINT "PK_d1bb243028e3428870107294541" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8b4d3d22be5bebd1e82c6b794" ON "profile_x_invite_credits" ("inviter_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0eb7815c7df3ac0c7e081fa16c" ON "profile_x_invite_credits" ("invitee_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ceb5e2b6148c6d60efc5e68acd" ON "profile_x_invite_credits" ("invite_code")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_chain_name_claims" ("address" character varying NOT NULL, "name" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "salt" text, "preclaim_height" integer, "preclaim_tx_hash" character varying, "claim_tx_hash" character varying, "update_tx_hash" character varying, "transfer_tx_hash" character varying, "error" text, "retry_count" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP, "last_attempt_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_12d98e2736ee30a34716ecd4630" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_d493ec0dafe95d9eace06e1d73" ON "profile_chain_name_claims" ("name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4c14d385670c57f268f3b9a760" ON "profile_chain_name_claims" ("preclaim_tx_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fd519159db76f77bbaf1eabe17" ON "profile_chain_name_claims" ("claim_tx_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_683f6d205ce1c5e69892fd161b" ON "profile_chain_name_claims" ("update_tx_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_abddb143285d89bbb957f2b51f" ON "profile_chain_name_claims" ("transfer_tx_hash")`,
    );
    await queryRunner.query(
      `CREATE TABLE "profile_cache" ("address" character varying NOT NULL, "fullname" character varying, "bio" text, "avatarurl" text, "username" character varying, "x_username" character varying, "chain_name" character varying, "public_name" character varying, "chain_expires_at" bigint, "last_seen_micro_time" bigint, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_5557d2c6dd21c0959d314fda7e7" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "notification_preferences" ("address" character varying NOT NULL, "type" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_1bffb2727c670a9717b47bda295" PRIMARY KEY ("address", "type"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "sync_state" ("id" character varying NOT NULL DEFAULT 'global', "last_synced_height" integer NOT NULL, "last_synced_hash" character varying NOT NULL, "tip_height" integer NOT NULL, "is_bulk_mode" boolean NOT NULL DEFAULT false, "backward_synced_height" integer, "live_synced_height" integer, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_4c68d03775b8818b4e50b6dba84" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "notification_device_challenges" ("id" SERIAL NOT NULL, "nonce" character varying NOT NULL, "address" character varying NOT NULL, "expires_at" TIMESTAMP NOT NULL, "consumed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_2340b1a1f085b58a89b40f127df" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_4c54f01a3daf8eab8a2e7dacca" ON "notification_device_challenges" ("nonce")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_897e79ee4892e3b17327b4e530" ON "notification_device_challenges" ("address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "plugin_sync_state" ("plugin_name" character varying NOT NULL, "version" integer NOT NULL DEFAULT '1', "last_synced_height" integer NOT NULL, "backward_synced_height" integer, "live_synced_height" integer, "start_from_height" integer NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_28cb993aa32d1d20148e3af9a19" PRIMARY KEY ("plugin_name"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_28cb993aa32d1d20148e3af9a1" ON "plugin_sync_state" ("plugin_name")`,
    );
    await queryRunner.query(
      `CREATE TABLE "device_tokens" ("expo_push_token" character varying NOT NULL, "address" character varying NOT NULL, "platform" character varying, "app_version" character varying, "device_id" character varying, "last_seen_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_f81462ef82a81bf4b7894ff1493" PRIMARY KEY ("expo_push_token"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a4b6d2ba0a79371005b5f60902" ON "device_tokens" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e74bf3adff79e094bd230d9f2b" ON "device_tokens" ("last_seen_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "txs" ("hash" character varying NOT NULL, "block_hash" character varying NOT NULL, "block_height" integer NOT NULL, "version" integer NOT NULL DEFAULT '1', "encoded_tx" character varying, "micro_index" bigint NOT NULL, "micro_time" bigint NOT NULL, "signatures" jsonb NOT NULL, "type" character varying NOT NULL, "payload" character varying, "contract_id" character varying, "function" character varying, "caller_id" character varying, "sender_id" character varying, "recipient_id" character varying, "raw" jsonb NOT NULL, "data" jsonb, "logs" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_9374ad26b97db2815d3f147aeaf" PRIMARY KEY ("hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1e7fa3fecb8e3976772b47e63d" ON "txs" ("function")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_96782bfb2460e32da30bce54e2" ON "txs" ("contract_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_873a275066da915a318dbd98f2" ON "txs" ("type")`,
    );
    await queryRunner.query(
      `CREATE TABLE "plugin_failed_transaction" ("plugin_name" character varying NOT NULL, "tx_hash" character varying NOT NULL, "error_message" text, "error_trace" text, "version" integer NOT NULL DEFAULT '1', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_a819c9f2d425a7dc12ee7745747" PRIMARY KEY ("plugin_name", "tx_hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_93de1c192aed604a2d9ceaff01" ON "plugin_failed_transaction" ("plugin_name", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8e0bfa232076701f88f2b8cc8c" ON "plugin_failed_transaction" ("tx_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0b79443c4b10d3a1029a50b02e" ON "plugin_failed_transaction" ("version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c64fd619d9431bf3896fdb6738" ON "plugin_failed_transaction" ("plugin_name")`,
    );
    await queryRunner.query(
      `CREATE TABLE "micro_blocks" ("hash" character varying NOT NULL, "height" integer NOT NULL, "prev_hash" character varying NOT NULL, "prev_key_hash" character varying NOT NULL, "state_hash" character varying NOT NULL, "time" numeric(78,0) NOT NULL DEFAULT '0', "transactions_count" integer NOT NULL DEFAULT '0', "flags" text NOT NULL, "version" integer NOT NULL, "gas" integer NOT NULL DEFAULT '0', "micro_block_index" integer NOT NULL DEFAULT '0', "pof_hash" character varying NOT NULL, "signature" character varying NOT NULL, "txs_hash" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_88e47c7d26eea03c1d017d233ba" PRIMARY KEY ("hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_468f66e164a7c2108366a2c304" ON "micro_blocks" ("prev_key_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_29f446b6508adf95f0f4c21092" ON "micro_blocks" ("prev_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_33bba91976387b8d72d2f18fc7" ON "micro_blocks" ("height")`,
    );
    await queryRunner.query(
      `CREATE TABLE "dex_token_summaries" ("token_address" character varying NOT NULL, "total_volume" jsonb NOT NULL, "change" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_350e04c6582d526919b5ee0f673" PRIMARY KEY ("token_address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "dex_tokens" ("address" character varying NOT NULL, "name" character varying NOT NULL, "symbol" character varying NOT NULL, "decimals" integer NOT NULL DEFAULT '18', "pairs_count" integer NOT NULL DEFAULT '0', "price" json, "is_ae" boolean NOT NULL DEFAULT false, "listed" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_1d32fbd39cc2b4ab18b35b7fde4" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "pair_transactions" ("tx_hash" character varying NOT NULL, "account_address" character varying, "block_height" integer NOT NULL DEFAULT '0', "tx_type" character varying NOT NULL, "reserve0" numeric NOT NULL DEFAULT '0', "reserve1" numeric NOT NULL DEFAULT '0', "ratio0" numeric NOT NULL DEFAULT '0', "ratio1" numeric NOT NULL DEFAULT '0', "total_supply" numeric NOT NULL DEFAULT '0', "volume0" numeric NOT NULL DEFAULT '0', "volume1" numeric NOT NULL DEFAULT '0', "market_cap0" numeric NOT NULL DEFAULT '0', "market_cap1" numeric NOT NULL DEFAULT '0', "market_cap" numeric NOT NULL DEFAULT '0', "swap_info" jsonb, "pair_mint_info" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "pair_address" character varying, CONSTRAINT "PK_8641c5577e5dedc6519405fec0c" PRIMARY KEY ("tx_hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pair_transactions_pair_created_at" ON "pair_transactions" ("pair_address", "created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "pair_summaries" ("pair_address" character varying NOT NULL, "volume_token" character varying(100) NOT NULL, "token_position" character varying(1) NOT NULL, "total_volume" jsonb NOT NULL, "change" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_8379e3b3bafb02fff4f63d1a487" PRIMARY KEY ("pair_address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "pairs" ("address" character varying NOT NULL, "reserve0" numeric NOT NULL DEFAULT '0', "reserve1" numeric NOT NULL DEFAULT '0', "total_supply" numeric NOT NULL DEFAULT '0', "ratio0" numeric NOT NULL DEFAULT '0', "ratio1" numeric NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "token0_address" character varying, "token1_address" character varying, CONSTRAINT "PK_e0c9d9aeacf3ad446a3a660ae6c" PRIMARY KEY ("address"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "key_blocks" ("hash" character varying NOT NULL, "height" integer NOT NULL, "prev_hash" character varying NOT NULL, "prev_key_hash" character varying NOT NULL, "state_hash" character varying NOT NULL, "beneficiary" character varying NOT NULL, "miner" character varying NOT NULL, "time" numeric(78,0) NOT NULL DEFAULT '0', "transactions_count" integer NOT NULL DEFAULT '0', "micro_blocks_count" integer NOT NULL DEFAULT '0', "beneficiary_reward" numeric(78,0) NOT NULL DEFAULT '0', "flags" text NOT NULL, "info" text NOT NULL, "nonce" numeric(78,0) NOT NULL DEFAULT '0', "pow" jsonb NOT NULL, "target" numeric(78,0) NOT NULL DEFAULT '0', "version" integer NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_2973b746bd72ea7bb80d32a9f6d" UNIQUE ("height"), CONSTRAINT "PK_eaf99520a2e5aff8ae07d1c975e" PRIMARY KEY ("hash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_11f35b7d8e099ce54a3fdcb225" ON "key_blocks" ("time")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_59894bf25a10b28250d56bfe8d" ON "key_blocks" ("prev_key_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ee189db79c5dfa7f7a5212f6b1" ON "key_blocks" ("prev_hash")`,
    );
    await queryRunner.query(
      `CREATE TABLE "failed_transactions" ("hash" character varying NOT NULL, "retries" integer NOT NULL DEFAULT '0', "error" character varying NOT NULL DEFAULT '', "error_trace" character varying NOT NULL DEFAULT '', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_86c82ec9e499f7a7fc807f7d25c" PRIMARY KEY ("hash"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "announcement_targets" ("id" SERIAL NOT NULL, "announcement_id" integer NOT NULL, "address" character varying NOT NULL, CONSTRAINT "PK_dc675d679d5429c4e50c3719f59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_79a88ad59c561fe01d69262816" ON "announcement_targets" ("announcement_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10aba7edd90f6b7c7e23604a53" ON "announcement_targets" ("address")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_announcement_targets" ON "announcement_targets" ("announcement_id", "address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "synced_blocks" ("block_number" integer NOT NULL, "total_bcl_transactions" integer NOT NULL DEFAULT '0', "synced_tx_hashes" text array NOT NULL DEFAULT '{}', "callers" text array NOT NULL DEFAULT '{}', "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_46359e704edfbd415f5d83c50ca" PRIMARY KEY ("block_number"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "announcements" ("id" SERIAL NOT NULL, "title" character varying NOT NULL, "description" text NOT NULL, "scheduled_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "target_type" character varying NOT NULL DEFAULT 'all', "feed_visible" boolean NOT NULL DEFAULT true, "claimed_at" TIMESTAMP, "claim_token" character varying, "attempt_count" integer NOT NULL DEFAULT '0', "processed_at" TIMESTAMP, "recipient_count" integer, "delivered_count" integer, "opted_out_count" integer, "no_channel_count" integer, "failed_count" integer, "error" text, "created_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_b3ad760876ff2e19d58e05dc8b0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6d906eac3e2332487f170bd088" ON "announcements" ("scheduled_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a298c06b8ffaf271cc4e1efce1" ON "announcements" ("claimed_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c029b9b1c824112fe2eb0e2011" ON "announcements" ("processed_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "analytics" ("id" SERIAL NOT NULL, "total_market_cap_sum" numeric NOT NULL DEFAULT 0, "total_volume_sum" numeric NOT NULL DEFAULT 0, "total_tokens" integer NOT NULL, "total_transactions" integer NOT NULL, "total_created_tokens" integer NOT NULL, "total_active_accounts" integer NOT NULL, "date" date NOT NULL, CONSTRAINT "UQ_19da8ae5e50dce0825eeaf1d1f2" UNIQUE ("date"), CONSTRAINT "PK_3c96dcbf1e4c57ea9e0c3144bff" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" SERIAL NOT NULL, "tx_hash" character varying NOT NULL, "block_height" integer NOT NULL, "amount" character varying NOT NULL DEFAULT '0', "sender_address" character varying NOT NULL, "invitee_address" character varying, "receiver_address" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "claim_tx_hash" character varying, "revoke_tx_hash" character varying, "status_updated_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_eed58e8fe5b0c5a419c2874faf9" UNIQUE ("receiver_address"), CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2489d3ff3035f347dbfa223ea1" ON "invitations" ("sender_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f071894adb4c67dbe01b7b920e" ON "invitations" ("invitee_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eed58e8fe5b0c5a419c2874faf" ON "invitations" ("receiver_address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "affiliation_codes" ("id" SERIAL NOT NULL, "private_code" character varying NOT NULL, "claimed_at" TIMESTAMP, "claimed_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "affiliationId" integer, CONSTRAINT "UQ_ecbbc489ab97f40259c3601f61e" UNIQUE ("private_code"), CONSTRAINT "PK_f3cb1e0f252ca88ea46bd6e233c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "affiliations" ("id" SERIAL NOT NULL, "account_address" character varying NOT NULL, "code" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "UQ_22f02566938a9065f3b2501074e" UNIQUE ("code"), CONSTRAINT "PK_454335765b4671b2e94313ec4b3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_549bb326b43d80e484d61e517f" ON "affiliations" ("account_address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_leaderboard_snapshots" ("id" SERIAL NOT NULL, "window" character varying(10) NOT NULL, "address" character varying(64) NOT NULL, "chain_name" character varying(64), "aum_usd" double precision NOT NULL DEFAULT '0', "pnl_usd" double precision NOT NULL DEFAULT '0', "roi_pct" double precision NOT NULL DEFAULT '0', "mdd_pct" double precision NOT NULL DEFAULT '0', "buy_count" integer NOT NULL DEFAULT '0', "sell_count" integer NOT NULL DEFAULT '0', "created_tokens_count" integer NOT NULL DEFAULT '0', "owned_trends_count" integer NOT NULL DEFAULT '0', "portfolio_value_usd_sparkline" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, "updated_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_0781241b15ce70b26f0254ff3fd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_MDD" ON "account_leaderboard_snapshots" ("window", "mdd_pct")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ROI" ON "account_leaderboard_snapshots" ("window", "roi_pct")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_PNL" ON "account_leaderboard_snapshots" ("window", "pnl_usd")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_AUM" ON "account_leaderboard_snapshots" ("window", "aum_usd")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ACCOUNT_LEADERBOARD_SNAPSHOTS_WINDOW_ADDRESS" ON "account_leaderboard_snapshots" ("window", "address")`,
    );
    await queryRunner.query(
      `CREATE TABLE "coin_prices" ("id" SERIAL NOT NULL, "rates" json NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_10f765cf68d2c2a9f5b37652010" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_50da4fbda5a37da64918f8f12f" ON "coin_prices" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "coin_historical_prices" ("id" SERIAL NOT NULL, "coin_id" character varying(50) NOT NULL, "currency" character varying(10) NOT NULL, "timestamp_ms" bigint NOT NULL, "price" numeric(20,8) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone, CONSTRAINT "PK_62e316822e023b9f289fd1d0bba" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_TIMESTAMP" ON "coin_historical_prices" ("timestamp_ms")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_COIN_CURRENCY_TIMESTAMP" ON "coin_historical_prices" ("coin_id", "currency", "timestamp_ms")`,
    );
    await queryRunner.query(
      `CREATE TABLE "post_topics" ("post_id" character varying NOT NULL, "topic_id" uuid NOT NULL, CONSTRAINT "PK_84b60a9c7aea7d3c828c26f6d18" PRIMARY KEY ("post_id", "topic_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ce06cab30d332c3ea040e55bb9" ON "post_topics" ("post_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fa971a43908f58fe75d73b1484" ON "post_topics" ("topic_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" ADD CONSTRAINT "FK_e55cc433639d0e21c3dbf637bce" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tips" ADD CONSTRAINT "FK_54e029c106ced40a8f4fda675fe" FOREIGN KEY ("sender_address") REFERENCES "accounts"("address") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tips" ADD CONSTRAINT "FK_7a2d24e0b2e5af1c66012107e6f" FOREIGN KEY ("receiver_address") REFERENCES "accounts"("address") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tips" ADD CONSTRAINT "FK_23bca09e70250174c7f4638d89b" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "dex_token_summaries" ADD CONSTRAINT "FK_350e04c6582d526919b5ee0f673" FOREIGN KEY ("token_address") REFERENCES "dex_tokens"("address") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pair_transactions" ADD CONSTRAINT "FK_9699e8d7c587d198bf1161b1fc4" FOREIGN KEY ("pair_address") REFERENCES "pairs"("address") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pair_summaries" ADD CONSTRAINT "FK_8379e3b3bafb02fff4f63d1a487" FOREIGN KEY ("pair_address") REFERENCES "pairs"("address") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pairs" ADD CONSTRAINT "FK_c3ce9fd1ca2dc85524110e13615" FOREIGN KEY ("token0_address") REFERENCES "dex_tokens"("address") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pairs" ADD CONSTRAINT "FK_5e033ee93d7f69919d3f7b93184" FOREIGN KEY ("token1_address") REFERENCES "dex_tokens"("address") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "affiliation_codes" ADD CONSTRAINT "FK_ca253acbc9a655c8cc1301e9533" FOREIGN KEY ("affiliationId") REFERENCES "affiliations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_topics" ADD CONSTRAINT "FK_ce06cab30d332c3ea040e55bb9a" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_topics" ADD CONSTRAINT "FK_fa971a43908f58fe75d73b1484f" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE TABLE "typeorm_metadata" ("type" character varying NOT NULL, "database" character varying, "schema" character varying, "table" character varying, "name" character varying, "value" text)`,
    );
    await queryRunner.query(`CREATE VIEW "governance_delegation_view" AS 
    SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      micro_time,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'delegator' as delegator,
      data->'governance'->'data'->>'delegatee' as delegatee
    FROM txs
    WHERE function = 'delegate'
      AND data->'governance'->'data'->>'delegator' IS NOT NULL
      AND data->'governance'->'data'->>'delegatee' IS NOT NULL
      AND data->'governance' IS NOT NULL`);
    await queryRunner.query(
      `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (DEFAULT, $1, DEFAULT, $2, $3, $4)`,
      [
        'public',
        'VIEW',
        'governance_delegation_view',
        `SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      micro_time,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'delegator' as delegator,
      data->'governance'->'data'->>'delegatee' as delegatee
    FROM txs
    WHERE function = 'delegate'
      AND data->'governance'->'data'->>'delegator' IS NOT NULL
      AND data->'governance'->'data'->>'delegatee' IS NOT NULL
      AND data->'governance' IS NOT NULL`,
      ],
    );
    await queryRunner.query(`CREATE VIEW "governance_poll_vote_view" AS 
    SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'poll_address' as poll_address
    FROM txs
    WHERE function IN ('vote', 'revoke_vote')
      AND data->'governance'->'data'->>'poll_address' IS NOT NULL
      AND data->'governance' IS NOT NULL`);
    await queryRunner.query(
      `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (DEFAULT, $1, DEFAULT, $2, $3, $4)`,
      [
        'public',
        'VIEW',
        'governance_poll_vote_view',
        `SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'poll_address' as poll_address
    FROM txs
    WHERE function IN ('vote', 'revoke_vote')
      AND data->'governance'->'data'->>'poll_address' IS NOT NULL
      AND data->'governance' IS NOT NULL`,
      ],
    );
    await queryRunner.query(`CREATE VIEW "governance_revoked_delegation_view" AS 
    SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      micro_time,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'delegator' as delegator
    FROM txs
    WHERE function = 'revoke_delegation'
      AND data->'governance'->'data'->>'delegator' IS NOT NULL
      AND data->'governance' IS NOT NULL`);
    await queryRunner.query(
      `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (DEFAULT, $1, DEFAULT, $2, $3, $4)`,
      [
        'public',
        'VIEW',
        'governance_revoked_delegation_view',
        `SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      micro_time,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'delegator' as delegator
    FROM txs
    WHERE function = 'revoke_delegation'
      AND data->'governance'->'data'->>'delegator' IS NOT NULL
      AND data->'governance' IS NOT NULL`,
      ],
    );
    await queryRunner.query(`CREATE VIEW "governance_poll_view" AS 
    SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'author' as author,
      data->'governance'->'data'->'metadata' as metadata,
      data->'governance'->'data'->>'poll_seq_id' as poll_seq_id,
      (data->'governance'->'data'->>'close_height')::int as close_height,
      data->'governance'->'data'->>'poll_address' as poll_address,
      data->'governance'->'data'->'vote_options' as vote_options,
      (data->'governance'->'data'->>'create_height')::int as create_height,
      (data->'governance'->'data'->>'close_at_height')::int as close_at_height,
      (
        SELECT COUNT(*)::int
        FROM txs v
        WHERE v.function = 'vote'
          AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
          AND v.data->'governance'->'data'->>'voter' IS NOT NULL
          AND v.data->'governance' IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM txs r
            WHERE r.function = 'revoke_vote'
              AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND r.data->'governance'->'data'->>'voter' = v.data->'governance'->'data'->>'voter'
              AND r.data->'governance' IS NOT NULL
              AND (
                r.block_height > v.block_height
                OR (r.block_height = v.block_height AND r.micro_time > v.micro_time)
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM txs v2
            WHERE v2.function = 'vote'
              AND v2.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND v2.data->'governance'->'data'->>'voter' = v.data->'governance'->'data'->>'voter'
              AND v2.data->'governance' IS NOT NULL
              AND (
                v2.block_height > v.block_height
                OR (v2.block_height = v.block_height AND v2.micro_time > v.micro_time)
              )
          )
      )::int as votes_count,
      (
        SELECT COALESCE(jsonb_object_agg(option_key::text, vote_count), '{}'::jsonb)
        FROM (
          SELECT 
            (latest_votes.data->'governance'->'data'->>'option')::int as option_key,
            COUNT(*)::int as vote_count
          FROM (
            SELECT DISTINCT ON (v.data->'governance'->'data'->>'voter')
              v.*
            FROM txs v
            WHERE v.function = 'vote'
              AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND v.data->'governance'->'data'->>'voter' IS NOT NULL
              AND v.data->'governance'->'data'->>'option' IS NOT NULL
              AND v.data->'governance' IS NOT NULL
            ORDER BY 
              v.data->'governance'->'data'->>'voter',
              v.block_height DESC,
              v.micro_time DESC
          ) latest_votes
          WHERE NOT EXISTS (
            SELECT 1
            FROM txs r
            WHERE r.function = 'revoke_vote'
              AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND r.data->'governance'->'data'->>'voter' = latest_votes.data->'governance'->'data'->>'voter'
              AND r.data->'governance' IS NOT NULL
              AND (
                r.block_height > latest_votes.block_height
                OR (r.block_height = latest_votes.block_height AND r.micro_time > latest_votes.micro_time)
              )
          )
          GROUP BY (latest_votes.data->'governance'->'data'->>'option')::int
        ) option_counts
      ) as votes_count_by_option,
      (
        SELECT COUNT(*)
        FROM txs r
        WHERE r.function = 'revoke_vote'
          AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
          AND r.data->'governance' IS NOT NULL
      )::int as votes_revoked_count
    FROM txs
    WHERE function = 'add_poll'
      AND data->'governance' IS NOT NULL
      AND data->'governance'->'data'->>'poll_address' IS NOT NULL`);
    await queryRunner.query(
      `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (DEFAULT, $1, DEFAULT, $2, $3, $4)`,
      [
        'public',
        'VIEW',
        'governance_poll_view',
        `SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'author' as author,
      data->'governance'->'data'->'metadata' as metadata,
      data->'governance'->'data'->>'poll_seq_id' as poll_seq_id,
      (data->'governance'->'data'->>'close_height')::int as close_height,
      data->'governance'->'data'->>'poll_address' as poll_address,
      data->'governance'->'data'->'vote_options' as vote_options,
      (data->'governance'->'data'->>'create_height')::int as create_height,
      (data->'governance'->'data'->>'close_at_height')::int as close_at_height,
      (
        SELECT COUNT(*)::int
        FROM txs v
        WHERE v.function = 'vote'
          AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
          AND v.data->'governance'->'data'->>'voter' IS NOT NULL
          AND v.data->'governance' IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM txs r
            WHERE r.function = 'revoke_vote'
              AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND r.data->'governance'->'data'->>'voter' = v.data->'governance'->'data'->>'voter'
              AND r.data->'governance' IS NOT NULL
              AND (
                r.block_height > v.block_height
                OR (r.block_height = v.block_height AND r.micro_time > v.micro_time)
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM txs v2
            WHERE v2.function = 'vote'
              AND v2.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND v2.data->'governance'->'data'->>'voter' = v.data->'governance'->'data'->>'voter'
              AND v2.data->'governance' IS NOT NULL
              AND (
                v2.block_height > v.block_height
                OR (v2.block_height = v.block_height AND v2.micro_time > v.micro_time)
              )
          )
      )::int as votes_count,
      (
        SELECT COALESCE(jsonb_object_agg(option_key::text, vote_count), '{}'::jsonb)
        FROM (
          SELECT 
            (latest_votes.data->'governance'->'data'->>'option')::int as option_key,
            COUNT(*)::int as vote_count
          FROM (
            SELECT DISTINCT ON (v.data->'governance'->'data'->>'voter')
              v.*
            FROM txs v
            WHERE v.function = 'vote'
              AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND v.data->'governance'->'data'->>'voter' IS NOT NULL
              AND v.data->'governance'->'data'->>'option' IS NOT NULL
              AND v.data->'governance' IS NOT NULL
            ORDER BY 
              v.data->'governance'->'data'->>'voter',
              v.block_height DESC,
              v.micro_time DESC
          ) latest_votes
          WHERE NOT EXISTS (
            SELECT 1
            FROM txs r
            WHERE r.function = 'revoke_vote'
              AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
              AND r.data->'governance'->'data'->>'voter' = latest_votes.data->'governance'->'data'->>'voter'
              AND r.data->'governance' IS NOT NULL
              AND (
                r.block_height > latest_votes.block_height
                OR (r.block_height = latest_votes.block_height AND r.micro_time > latest_votes.micro_time)
              )
          )
          GROUP BY (latest_votes.data->'governance'->'data'->>'option')::int
        ) option_counts
      ) as votes_count_by_option,
      (
        SELECT COUNT(*)
        FROM txs r
        WHERE r.function = 'revoke_vote'
          AND r.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
          AND r.data->'governance' IS NOT NULL
      )::int as votes_revoked_count
    FROM txs
    WHERE function = 'add_poll'
      AND data->'governance' IS NOT NULL
      AND data->'governance'->'data'->>'poll_address' IS NOT NULL`,
      ],
    );
  }

  public async down(): Promise<void> {
    // Existing databases record this as their newest migration, so it is the
    // first one `migration:revert` undoes; dropping the schema here would wipe them.
  }
}
