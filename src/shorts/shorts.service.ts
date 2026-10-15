import { shortsRuntimeScope } from './shorts-runtime-scope';
import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService, SHORTS_TOPICS } from './shorts-labels.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Optional,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ShortsChainService, ae } from './shorts-chain.service';
import { shortsRelease } from './shorts-release';
import { ShortsMediaService } from './shorts-media.service';
import { DemoActor, ShortRecord } from './shorts.types';
import {
  communityGuidelines,
  creatorContent,
  officialContentPolicy,
} from './shorts-eligibility';
import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsAuthService } from './shorts-auth.service';
import { ShortsUploadLimitsService } from './shorts-upload-limits.service';
import { ShortsRecordsService } from './shorts-records.service';

import { ShortsApiPublicationService } from './shorts-api-publication.service';
import { catalogCursor, catalogMap } from './shorts-catalog';
import { ShortsFollowingService } from './shorts-following.service';
import {
  ShortsStudioReadService,
  StudioRow,
} from './shorts-studio-read.service';

export const TOPICS = ['All', ...SHORTS_TOPICS];
@Injectable()
export class ShortsService {
  private catalogRequests = 0;
  constructor(
    readonly chain: ShortsChainService,
    readonly media: ShortsMediaService,
    readonly analytics: ShortsAnalyticsService,
    readonly ledger: ShortsLedgerService,
    readonly labels: ShortsLabelsService,
    readonly auth: ShortsAuthService,
    readonly streaming: ShortsStreamingService,
    readonly uploadLimits: ShortsUploadLimitsService,
    readonly records: ShortsRecordsService = new ShortsRecordsService(chain),
    @Optional() readonly publisher?: ShortsApiPublicationService,
    @Optional() readonly studioRead?: ShortsStudioReadService,
    @Optional() readonly following?: ShortsFollowingService,
  ) {}
  get demoAutoApprove() {
    return this.media?.safety?.demoAutoApprove === true;
  }
  async item(id: string) {
    return this.records.get(id);
  }
  async playbackHealth() {
    try {
      const [storage, contract] = await Promise.all([
        this.media.health(),
        this.chain.read('get_config'),
      ]);
      if (!storage || !contract) throw new Error('Dependency unavailable');
      return { status: 'ready', protocol: 'shorts-playback-v1' };
    } catch {
      throw new ServiceUnavailableException(
        'Playback dependencies unavailable',
      );
    }
  }
  async config() {
    const scope = shortsRuntimeScope(this.chain);
    const release = shortsRelease(this.chain.release, true);
    const [ipfs, visualModeration] = await Promise.all([
      this.media.health(),
      this.media.safety.health(),
    ]);
    shortsRuntimeScope(this.chain);
    if (
      JSON.stringify(shortsRelease(this.chain.release, true)) !==
      JSON.stringify(release)
    )
      throw new ServiceUnavailableException(
        'Shorts release changed while loading configuration',
      );
    return {
      release,
      mode: scope.network === 'ae_uat' ? 'testnet' : 'mainnet',
      catalogPaging: true,
      followingPaging: !!this.following,
      studioPaging: !!this.studioRead,
      hosting: 'platform-funded',
      realtime: this.ledger?.realtime === true,
      previousContract: this.chain.previous?.$options.address,
      previousAci: this.chain.previousArtifact?.aci,
      ...scope,
      likeFee: ae(release.likeFeeAetto),
      creatorShare: (10000 - release.treasuryBps) / 100,
      treasuryShare: release.treasuryBps / 100,
      ipfs,
      visualModeration,
      moderationMode: this.demoAutoApprove ? 'demo' : 'review',
      creatorAccess: this.auth?.connectedWalletAccess
        ? 'connected-wallet'
        : 'signed-session',
      classification: this.demoAutoApprove
        ? 'Creator-selected topics; demo auto-approval'
        : 'Local frame inspection + human review',
      analyticsSince: this.analytics.since,
      topics: TOPICS,
      operator: this.chain.operator.address,
      aci: this.chain.artifact.aci,
      bytecodeHash: this.chain.artifact.bytecodeHash,
    };
  }
  matchesPublication(short: ShortRecord, publication: any) {
    try {
      return (
        !!publication &&
        publication.cid === short.cid &&
        publication.creator === short.creator &&
        BigInt(publication.size) === BigInt(short.bytes)
      );
    } catch {
      return false;
    }
  }
  private async describe(
    s: ShortRecord,
    address = '',
    studio = false,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const v = await this.chain.read('get_short', [s.id], signal);
    signal?.throwIfAborted();
    if (!studio && v && !this.matchesPublication(s, v))
      throw new NotFoundException('Video is not available');
    const publicationStatus =
      v?.withdrawn || s.publication === 'withdrawn'
        ? 'withdrawn'
        : v && (!this.records.shared || s.publication === 'published')
          ? 'published'
          : 'draft';
    return this.present(s, address, studio, publicationStatus, {
      ...(await this.analytics.counters(s.id)),
      likes: v ? Number(v.likes) : 0,
      liked:
        v && address
          ? await this.chain.read('has_liked', [address, s.id], signal)
          : false,
    });
  }
  private present(
    s: ShortRecord,
    address: string,
    studio: boolean,
    publicationStatus: 'published' | 'draft' | 'withdrawn',
    metrics: {
      views: number;
      likes: number;
      liked: boolean;
      engagement?: { score: number };
    },
  ) {
    const guidelines = communityGuidelines(s, this.demoAutoApprove);
    const status =
      publicationStatus === 'withdrawn'
        ? 'withdrawn'
        : publicationStatus === 'draft'
          ? 'draft'
          : guidelines.status === 'ineligible'
            ? 'rejected'
            : guidelines.status !== 'eligible'
              ? 'pending'
              : 'active';
    return {
      ...creatorContent(s, this.demoAutoApprove),
      appeal: studio ? s.appeal : undefined,
      captions: !!s.captions,
      ...metrics,
      status,
      publicationStatus,
      publicationPending: s.publication === 'pending',
      contentWarning:
        guidelines.status === 'eligible'
          ? undefined
          : guidelines.status === 'ineligible'
            ? 'feed-excluded'
            : 'unreviewed',
      mine: s.creator === address,
    };
  }
  async shared(id: string, actor = '') {
    const short = await this.ensurePlayable(id);
    const result = await this.describe(
      short,
      actor ? this.chain.address(actor) : '',
    );
    if (
      result.publicationStatus !== 'published' ||
      !officialContentPolicy(await this.item(id), this.demoAutoApprove).serve
    )
      throw new NotFoundException('Video is not available');
    return result;
  }
  private async catalogRead<T>(work: () => Promise<T>) {
    // Per-instance work limit, in addition to shared HTTP and database admission.
    // This is not a distributed lock; catalog reads recheck current shared policy.
    if (this.catalogRequests >= 4)
      throw new ServiceUnavailableException(
        'Shorts catalog is busy; try again shortly',
      );
    this.catalogRequests += 1;
    try {
      return await work();
    } finally {
      this.catalogRequests -= 1;
    }
  }
  private async catalogItem(s: ShortRecord, address: string, studio: boolean) {
    if (
      !studio &&
      (!officialContentPolicy(s, this.demoAutoApprove).discover ||
        (this.records.shared && s.publication !== 'published'))
    )
      return undefined;
    try {
      const result = await this.describe(s, address, studio);
      if (studio) return result.mine ? result : undefined;
      const current = await this.item(s.id);
      return result.publicationStatus === 'published' &&
        (!this.records.shared || current.publication === 'published') &&
        officialContentPolicy(current, this.demoAutoApprove).discover
        ? result
        : undefined;
    } catch (error) {
      if (error instanceof NotFoundException && !studio) return undefined;
      throw error;
    }
  }
  /** A page bounds scanned records as well as chain work; an empty page may have a next cursor. */
  async catalog(actor = '', cursor?: string, studio = false) {
    const address = actor ? this.chain.address(actor) : '';
    if (studio && !address)
      throw new BadRequestException('Creator access required');
    const paging = catalogCursor(
      [
        shortsRuntimeScope(this.chain).network,
        this.chain.state.contract,
        this.chain.state.sourceHash,
        studio ? 'studio' : 'feed',
        address,
      ],
      cursor,
    );
    return this.catalogRead(async () => {
      const page = await this.records.page(
        studio ? address : undefined,
        paging.after,
      );
      const rows = await catalogMap(page.items, (s) =>
        this.catalogItem(s, address, studio),
      );
      return {
        items: rows.filter((row) => row !== undefined),
        next: page.next ? paging.encode(page.next) : null,
      };
    });
  }
  /** Select globally from followed creators, then apply the same public content checks. */
  async followingCatalog(actor = '', cursor?: string) {
    if (typeof actor !== 'string' || !actor || actor.length > 100)
      throw new BadRequestException('Choose an account for Following');
    const address = this.chain.address(actor);
    if (!this.following)
      throw new ServiceUnavailableException('Following is unavailable');
    return this.catalogRead(async () => {
      const page = await this.following!.page(
        shortsRuntimeScope(this.chain),
        this.chain.state.sourceHash,
        address,
        cursor,
      );
      const results = await catalogMap(page.ids, async (id) => {
        const record = await this.records.find(id);
        return record ? this.catalogItem(record, address, false) : undefined;
      });
      const rows = results.filter((row) => row !== undefined);
      const current = await this.following!.creators(
        page.graph,
        address,
        rows.map((row) => row.creator),
      );
      if (current.revision !== page.revision)
        throw new ConflictException('Following changed. Refresh the feed.');
      return {
        items: rows.filter((row) => current.creators.has(row.creator)),
        next: page.next,
        revision: current.revision,
      };
    });
  }
  /** Operator authorization is enforced before entering this bounded read. */
  async reviewPage(operator: string, cursor?: string) {
    const paging = catalogCursor(
      [
        shortsRuntimeScope(this.chain).network,
        this.chain.state.contract,
        this.chain.state.sourceHash,
        'review',
        this.chain.address(operator),
      ],
      cursor,
    );
    return this.catalogRead(async () => {
      const page = await this.records.reviewPage(paging.after);
      return {
        items: page.items.map((s) => ({
          id: s.id,
          title: s.title,
          moderation: s.moderation,
          topic: s.topic,
          reports: s.reports,
          reportDetails: s.reportDetails || [],
          classification: s.classification,
          safety: s.safety,
          reviewReason: s.reviewReason,
          reviewedTopic: s.reviewedTopic,
          reviewHistory: s.reviewHistory,
          description: s.description,
          language: s.language,
          synthetic: s.synthetic,
          sponsored: s.sponsored,
          appeal: s.appeal,
          previewUrl: `/api/shorts/review-media/${s.id}`,
        })),
        next: page.next ? paging.encode(page.next) : null,
      };
    });
  }
  /** Refresh only a bounded client window; IDs never bypass public eligibility. */
  async catalogState(actor: string, ids: unknown, following = false) {
    if (
      typeof actor !== 'string' ||
      actor.length > 100 ||
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some(
        (id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id),
      ) ||
      new Set(ids).size !== ids.length
    )
      throw new BadRequestException('Choose up to 20 distinct Shorts');
    const address = actor ? this.chain.address(actor) : '';
    if (following && !address)
      throw new BadRequestException('Choose an account for Following');
    if (following && !this.following)
      throw new ServiceUnavailableException('Following is unavailable');
    return this.catalogRead(async () => {
      const graph = following
        ? await this.following!.current(shortsRuntimeScope(this.chain).network)
        : undefined;
      const rows = await catalogMap(ids as string[], async (id) => {
        const record = await this.records.find(id);
        return record?.publication === 'published'
          ? this.catalogItem(record, address, false)
          : undefined;
      });
      const visible = rows.filter((row) => row !== undefined);
      if (!graph) return { items: visible };
      const current = await this.following!.creators(
        graph,
        address,
        visible.map((row) => row.creator),
      );
      return {
        items: visible.filter((row) => current.creators.has(row.creator)),
        revision: current.revision,
      };
    });
  }
  async list(actor = '', topic = 'All', studio = false) {
    if (this.records.shared)
      throw new GoneException(
        'Use the paginated Shorts feed or Studio endpoints',
      );
    const address = actor ? this.chain.address(actor) : '';
    const rows = await this.catalogRead(async () =>
      catalogMap(await this.records.all(studio ? address : undefined), (s) =>
        this.catalogItem(s, address, studio),
      ),
    );
    return rows.filter(Boolean).sort((a, b) => {
      const match = (s: typeof a) =>
        topic !== 'All' && s.topic === topic ? 1 : 0;
      return match(b) - match(a) || b.createdAt - a.createdAt;
    });
  }
  async upload(
    actor: DemoActor,
    title: string,
    topic: string,
    data: Buffer,
    details: {
      description?: string;
      language?: string;
      synthetic?: boolean;
      sponsored?: boolean;
      captions?: string;
    } = {},
    uploadId?: string,
  ) {
    if (this.records.shared)
      throw new ServiceUnavailableException(
        'Hosted uploads require the shared upload service',
      );
    if (
      !title?.trim() ||
      title.length > 100 ||
      !TOPICS.slice(1).includes(topic)
    )
      throw new Error('Provide a title and a supported topic');
    if (
      (details.description?.length || 0) > 1000 ||
      (details.captions?.length || 0) > 10000 ||
      !['und', 'en', 'ar', 'fr', 'es', 'de', 'zh'].includes(
        details.language || 'und',
      )
    )
      throw new Error('Invalid description, captions or language');
    if (
      details.captions &&
      (!details.captions.startsWith('WEBVTT') ||
        !details.captions.includes('-->') ||
        /<[^>]+>|STYLE|REGION|X-TIMESTAMP-MAP/.test(details.captions))
    )
      throw new Error(
        'Use plain WebVTT captions with timed cues, without markup',
      );
    const id = uploadId || randomUUID();
    const existing = await this.records.find(id);
    if (existing) {
      if (existing.creator !== actor)
        throw new Error('Upload identity mismatch');
      return existing;
    }
    if ((await this.records.all()).length >= 50)
      throw new Error('Local preview is limited to 50 videos');
    this.chain.address(actor);
    if (!Buffer.isBuffer(data)) throw new Error('Choose a video');
    if (!uploadId) this.uploadLimits.reserve(actor, id, data.length);
    this.uploadLimits.beginPreparation(actor, id, data.length);
    try {
      const prepared = await this.media.prepare(
        id,
        data,
        title.trim(),
        topic,
        details,
      );
      const short: ShortRecord = {
        id,
        creator: this.chain.address(actor),
        title: title.trim(),
        topic,
        ...prepared,
        createdAt: Date.now(),
        description: details.description || '',
        language: details.language || 'und',
        synthetic: details.synthetic === true,
        sponsored: details.sponsored === true,
        captions: !!details.captions,
        classification: this.demoAutoApprove
          ? undefined
          : await this.labels.classify({
              title: title.trim(),
              topic,
              description: details.description,
              captions: details.captions,
            }),
        moderation:
          prepared.safety?.status === 'blocked'
            ? ('rejected' as const)
            : ('pending' as const),
        reviewReason: prepared.safety?.reason,
        views: [],
        reports: 0,
      };
      // Registration commits the private draft; it never publishes or signs.
      return await this.records.register(short);
    } catch (error) {
      // No publication occurs here. A registration failure must not leave an
      // in-memory draft or encrypted originals/packages outside the registry.
      if (!(await this.records.find(id))) await this.media.removePrepared(id);
      throw error;
    }
  }
  async moderate(
    id: string,
    approve: boolean,
    reason = '',
    topic?: string,
    visualConfirmed = false,
  ) {
    const short = await this.records.change(id, (short) => {
      if (topic && !TOPICS.slice(1).includes(topic))
        throw new BadRequestException('Choose a supported review topic');
      if (typeof reason !== 'string' || reason.length > 1000)
        throw new BadRequestException('Invalid review reason');
      if (approve) {
        if (!short.safety || ['blocked', 'error'].includes(short.safety.status))
          throw new ConflictException(
            'A completed visual scan without a blocking flag is required before approval',
          );
        if (
          short.safety.status === 'review' &&
          (!visualConfirmed || reason.trim().length < 10)
        )
          throw new BadRequestException(
            'Watch the full video and explicitly confirm the flagged frames with a review reason',
          );
        short.visualReviewHash = short.safety.evidenceHash;
      }
      short.reviewedTopic = topic || short.reviewedTopic || short.topic;
      short.moderation = approve ? 'approved' : 'rejected';
      short.reviewReason =
        reason.slice(0, 1000) ||
        (approve
          ? 'Approved by the operator'
          : 'Restricted by the operator. You may appeal from Studio.');
      short.reviewHistory ||= [];
      short.reviewHistory.push({
        at: Date.now(),
        operator: this.chain.operator.address,
        reason: short.reviewReason,
        approved: approve,
        topic: short.reviewedTopic,
      });
      if (short.appeal) short.appeal.status = 'resolved';
    });
    if (approve && short.publication === 'published')
      await this.streaming?.enqueue(short.id);
    return { status: short.moderation };
  }
  /** Retry only missing/failed evidence; do not invalidate this job before its IO. */
  async retryInspection(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const short = await this.item(id);
    if (
      short.publication === 'withdrawn' ||
      short.moderation === 'rejected' ||
      (short.safety && short.safety.status !== 'error')
    )
      return;
    const before = JSON.stringify(short);
    const safety = await this.media.rescan(short, signal);
    signal?.throwIfAborted();
    await this.records.change(id, (current) => {
      signal?.throwIfAborted();
      if (JSON.stringify(current) !== before)
        throw new ConflictException(
          'Content changed during inspection; retry current work',
        );
      current.safety = safety;
      current.scanGeneration = randomUUID();
      current.visualReviewHash = undefined;
      current.moderation = safety.status === 'blocked' ? 'rejected' : 'pending';
      current.reviewReason =
        safety.status === 'no_flags' ? undefined : safety.reason;
    });
  }
  async rescan(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.demoAutoApprove) return (await this.item(id)).safety;
    const scanGeneration = randomUUID();
    const short = await this.records.change(id, (current) => {
      signal?.throwIfAborted();
      current.moderation = 'pending';
      current.safety = undefined;
      current.visualReviewHash = undefined;
      current.reviewReason = undefined;
      current.scanGeneration = scanGeneration;
    });
    const safety = await this.media.rescan(short, signal);
    signal?.throwIfAborted();
    const updated = await this.records.change(id, (current) => {
      signal?.throwIfAborted();
      if (
        current.scanGeneration !== scanGeneration ||
        current.moderation !== 'pending'
      )
        throw new ConflictException(
          'A newer scan or review replaced this inspection',
        );
      current.safety = safety;
      if (safety?.status !== 'no_flags') {
        current.moderation =
          safety?.status === 'blocked' ? 'rejected' : 'pending';
        current.reviewReason = safety?.reason;
      }
    });
    return updated.safety;
  }
  async publish(actor: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const creator = this.chain.address(actor);
    const check = (short: ShortRecord) => {
      signal?.throwIfAborted();
      if (short.creator !== creator)
        throw new Error('Only the creator can publish this Short');
      if (short.publication === 'withdrawn')
        throw new Error('Withdrawn Shorts cannot be published');
      if (!officialContentPolicy(short, this.demoAutoApprove).publish)
        throw new ForbiddenException(
          'This Short is not approved for publication',
        );
    };
    const current = async () => {
      const short = await this.item(id);
      check(short);
      return short;
    };
    let short = await current();
    if (this.records.shared) {
      if (!this.publisher)
        throw new ServiceUnavailableException(
          'Publisher connection is unavailable',
        );
      if (short.publication === 'published') {
        const existing = await this.chain.read('get_short', [id], signal);
        if (!this.matchesPublication(short, existing) || existing.withdrawn)
          throw new ConflictException(
            'Published content does not match the registry',
          );
        await current();
        return this.publication(actor, id, signal);
      }
      // The same metadata transaction schedules durable lifecycle work. The
      // request acknowledges intent; only its claimed worker may upload media.
      if (short.publication !== 'pending')
        await this.records.change(id, (record) => {
          check(record);
          if (record.publication !== 'published')
            record.publication = 'pending';
        });
      return this.publication(actor, id, signal);
    }
    const existing = await this.chain.read('get_short', [id], signal);
    if (existing?.withdrawn)
      throw new Error('Withdrawn Shorts cannot be published');
    if (existing && !this.matchesPublication(short, existing))
      throw new ConflictException(
        'Published content does not match the registry',
      );
    if (!existing) {
      short = await this.records.change(id, (record) => {
        check(record);
        record.publication = 'pending';
      });
      short = await current();
      await this.media.pin(short, signal);
      short = await current();
      await this.chain.write('publish', [
        id,
        short.creator,
        short.cid,
        short.bytes,
      ]);
    }
    short = await this.records.change(id, (record) => {
      check(record);
      record.publication = 'published';
    });
    signal?.throwIfAborted();
    await this.streaming?.enqueue(id);
    return this.describe(short, actor, true, signal);
  }
  async publication(actor: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let short = await this.item(id);
    if (short.creator !== actor)
      throw new ForbiddenException('Creator access required');
    if (!this.records.shared) return this.describe(short, actor, true, signal);
    if (!this.publisher)
      throw new ServiceUnavailableException(
        'Publisher connection is unavailable',
      );
    const job = await this.publisher.status(id, actor, signal);
    signal?.throwIfAborted();
    if (
      short.publication !== 'published' &&
      !['confirmed', 'reconciled'].includes(job?.status ?? '')
    ) {
      // A saved request is observable even while storage or the node is down.
      // No unconfirmed registry record grants publication or viewing access.
      return {
        ...this.present(
          short,
          actor,
          true,
          short.publication === 'withdrawn' ? 'withdrawn' : 'draft',
          { ...(await this.analytics.counters(id)), likes: 0, liked: false },
        ),
        publicationRequest:
          job?.status ??
          (short.publication === 'pending' ? 'preparing' : undefined),
      };
    }
    if (job && ['confirmed', 'reconciled'].includes(job.status)) {
      const video = await this.chain.read('get_short', [id], signal);
      if (!this.matchesPublication(short, video) || video.withdrawn)
        throw new ConflictException('Publication needs reconciliation');
      short = await this.records.change(id, (record) => {
        signal?.throwIfAborted();
        if (
          record.publication === 'withdrawn' ||
          !officialContentPolicy(record, this.demoAutoApprove).publish
        )
          throw new ForbiddenException('Publication is no longer approved');
        record.publication = 'published';
      });
      signal?.throwIfAborted();
      await this.streaming?.enqueue(id);
    }
    return {
      ...(await this.describe(short, actor, true, signal)),
      publicationRequest: job?.status,
    };
  }
  async view(id: string, session: string) {
    if (!/^[a-zA-Z0-9-]{10,80}$/.test(session))
      throw new Error('Invalid session');
    await this.ensurePlayable(id);
    // Compatibility only: views must qualify through measured playback.
    return this.analytics.counters(id);
  }
  // Public metadata only. Video bytes are delivered by superhero-video-streaming.
  async playbackDescriptor(id: string) {
    const short = await this.ensurePlayable(id);
    return {
      id: short.id,
      cid: short.cid,
      ...shortsRuntimeScope(this.chain),
      files: short.files.filter((file) =>
        ['video.mp4', 'poster.jpg', 'captions.vtt'].includes(file.name),
      ),
    };
  }
  async ensurePlayable(id: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new NotFoundException();
    let s = await this.records.find(id);
    if (
      !s ||
      (this.records.shared && s.publication !== 'published') ||
      !officialContentPolicy(s, this.demoAutoApprove).serve
    )
      throw new NotFoundException('Video is not available');
    const v = await this.chain.read('get_short', [id]);
    if (this.records.shared) {
      if (!this.publisher)
        throw new ServiceUnavailableException(
          'Publisher connection is unavailable',
        );
      const job = await this.publisher.status(id, s.creator);
      if (job && !['confirmed', 'reconciled'].includes(job.status))
        throw new NotFoundException('Publication is not confirmed');
      // Legacy imported publications may have no journal entry. They still
      // require an exact current-chain identity and policy match below.
    }
    s = await this.records.find(id);
    if (
      !s ||
      !v ||
      (this.records.shared && s.publication !== 'published') ||
      v.withdrawn ||
      !this.matchesPublication(s, v) ||
      !officialContentPolicy(s, this.demoAutoApprove).serve
    )
      throw new NotFoundException('Video is not available');
    return s;
  }
  async appeal(actor: string, id: string, message: string) {
    await this.records.change(id, (s) => {
      if (s.creator !== actor || s.moderation !== 'rejected')
        throw new ForbiddenException(
          'Only the creator of restricted content can appeal',
        );
      if (
        typeof message !== 'string' ||
        message.trim().length < 10 ||
        message.length > 1000
      )
        throw new BadRequestException(
          'Explain your appeal in 10–1000 characters',
        );
      if (s.appeal?.status === 'pending')
        throw new ConflictException('Your appeal is already awaiting review');
      s.appeal = { message: message.trim(), at: Date.now(), status: 'pending' };
    });
    return { status: 'pending' };
  }
  async report(
    id: string,
    body: { id: string; reason: string; detail?: string },
  ) {
    await this.records.change(id, (s) => {
      if (
        !body ||
        !/^[a-zA-Z0-9-]{20,80}$/.test(body.id) ||
        !['Safety', 'Harassment', 'Copyright', 'Spam', 'Other'].includes(
          body.reason,
        ) ||
        (body.detail !== undefined && typeof body.detail !== 'string') ||
        (body.detail?.length || 0) > 1000
      )
        throw new BadRequestException(
          'Choose a reason and keep details under 1000 characters',
        );
      s.reportDetails ||= [];
      if (s.reportDetails.some((r) => r.id === body.id)) return;
      if (s.reportDetails.length >= 1000)
        throw new ServiceUnavailableException(
          'This video already has a full review queue',
        );
      s.reportDetails.push({
        ...body,
        detail: body.detail || '',
        at: Date.now(),
      });
      s.reports++;
    });
    return { received: true };
  }
  async performance(actor: string, days: number, shortId?: string) {
    if (![7, 28, 90].includes(days)) throw new Error('Choose 7, 28 or 90 days');
    const address = this.chain.address(actor);
    return this.catalogRead(() =>
      this.performanceReport(address, days, shortId),
    );
  }
  private async performanceReport(
    actor: string,
    days: number,
    shortId?: string,
  ) {
    const analytics = this.analytics.creatorReport
      ? await this.analytics.creatorReport(actor, days, shortId)
      : await this.localPerformance(actor, days, shortId);
    const finance = await this.ledger.report(
      actor,
      analytics.start,
      analytics.end,
      shortId,
    );
    const previousFinance = await this.ledger.report(
      actor,
      analytics.start - days * 86400000,
      analytics.start,
      shortId,
    );
    const topIds = Object.keys(analytics.videos ?? {})
      .filter((id) => analytics.videos[id].views > 0)
      .sort(
        (a, b) =>
          analytics.videos[b].views - analytics.videos[a].views ||
          a.localeCompare(b),
      )
      .slice(0, 5);
    const topShorts = this.studioRead
      ? topIds.length
        ? (
            await this.studioRead.page(
              actor,
              { days },
              { ids: topIds, limit: 5 },
            )
          ).items.map((row) => this.studioItem(row))
        : []
      : undefined;
    return {
      ...analytics,
      topShorts,
      finance,
      previousFinance: {
        earned: previousFinance.earned,
        paidLikes: previousFinance.paidLikes,
      },
      generatedAt: Date.now(),
    };
  }
  private async localPerformance(
    actor: string,
    days: number,
    shortId?: string,
  ) {
    // Only the deliberately capped local adapter needs the full list of IDs.
    if (this.records.shared)
      throw new ServiceUnavailableException(
        'Creator analytics are unavailable',
      );
    const own = await this.records.all(actor);
    if (shortId && !own.some((s) => s.id === shortId))
      throw new NotFoundException('Short not found');
    return this.analytics.report(
      own.filter((s) => !shortId || s.id === shortId).map((s) => s.id),
      days,
    );
  }
  private studioItem(row: StudioRow) {
    return {
      ...this.present(row.record, row.record.creator, true, row.publication, {
        views: row.views,
        likes: row.likes,
        liked: false,
      }),
      periodViews: row.periodViews,
    };
  }
  async studioContent(actor: string, query: Record<string, unknown> = {}) {
    const creator = this.chain.address(actor);
    if (!this.studioRead)
      throw new ServiceUnavailableException('Studio paging is unavailable');
    return this.catalogRead(async () => {
      const page = await this.studioRead.page(creator, query);
      return { ...page, items: page.items.map((row) => this.studioItem(row)) };
    });
  }
  async studioSummary(actor: string, days: unknown = 28) {
    const creator = this.chain.address(actor);
    if (!this.studioRead)
      throw new ServiceUnavailableException('Studio paging is unavailable');
    return this.catalogRead(async () => {
      const page = await this.studioRead.page(creator, { days }, { limit: 4 });
      const account = await this.chain.account(creator);
      return {
        account,
        shorts: page.items.map((row) => this.studioItem(row)),
        library: page.counts,
        index: page.index,
        period: page.period,
      };
    });
  }
  async studioVideo(actor: string, id: string, days: unknown = 28) {
    const creator = this.chain.address(actor);
    if (!this.studioRead)
      throw new ServiceUnavailableException('Studio paging is unavailable');
    return this.catalogRead(async () => {
      const page = await this.studioRead.page(
        creator,
        { days },
        { ids: [id], limit: 1 },
      );
      if (!page.items[0]) throw new NotFoundException('Short not found');
      return {
        video: this.studioItem(page.items[0]),
        index: page.index,
        period: page.period,
      };
    });
  }
  async dashboard(actor: DemoActor) {
    if (this.records.shared)
      throw new GoneException(
        'Use the Studio summary and paginated content endpoints',
      );
    const account = await this.chain.account(actor);
    const shorts = await this.list(actor, 'All', true);
    const receipts = await this.chain.receiptHistory(actor);
    return {
      account,
      shorts,
      receipts,
      totalViews: shorts.reduce((n, s) => n + s.views, 0),
      totalLikes: shorts.reduce((n, s) => n + s.likes, 0),
    };
  }
}
