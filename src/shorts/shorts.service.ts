import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService, SHORTS_TOPICS } from './shorts-labels.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsMediaService } from './shorts-media.service';
import { DemoActor, ShortRecord } from './shorts.types';
import { communityGuidelines, creatorContent } from './shorts-eligibility';
import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsAuthService } from './shorts-auth.service';

export const TOPICS = ['All', ...SHORTS_TOPICS];
@Injectable()
export class ShortsService {
  constructor(
    readonly chain: ShortsChainService,
    readonly media: ShortsMediaService,
    readonly analytics: ShortsAnalyticsService,
    readonly ledger: ShortsLedgerService,
    readonly labels: ShortsLabelsService,
    readonly auth: ShortsAuthService,
    readonly streaming: ShortsStreamingService,
  ) {}
  get demoAutoApprove() {
    return this.media.safety?.demoAutoApprove === true;
  }
  item(id: string) {
    const item = this.chain.state.shorts.find((s) => s.id === id);
    if (!item) throw new Error('Short not found');
    return item;
  }
  async config() {
    return {
      mode: 'testnet',
      hosting: 'platform-funded',
      previousContract: this.chain.previous?.$options.address,
      previousAci: this.chain.previousArtifact?.aci,
      network: 'ae_uat',
      contract: this.chain.state.contract,
      likeFee: '0.1',
      creatorShare: 80,
      treasuryShare: 20,
      ipfs: await this.media.health(),
      visualModeration: await this.media.safety.health(),
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
  private async describe(s: ShortRecord, address = '', studio = false) {
    const v = await this.chain.read('get_short', [s.id]);
    const publicationStatus =
      v?.withdrawn || s.publication === 'withdrawn'
        ? 'withdrawn'
        : v
          ? 'published'
          : 'draft';
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
      ...this.analytics.counters(s.id),
      status,
      publicationStatus,
      contentWarning:
        guidelines.status === 'eligible'
          ? undefined
          : guidelines.status === 'ineligible'
            ? 'feed-excluded'
            : 'unreviewed',
      likes: v ? Number(v.likes) : 0,
      liked:
        v && address
          ? await this.chain.read('has_liked', [address, s.id])
          : false,
      mine: s.creator === address,
    };
  }
  async shared(id: string, actor = '') {
    const short = await this.ensurePlayable(id);
    const result = await this.describe(
      short,
      actor ? this.chain.address(actor) : '',
    );
    if (result.publicationStatus !== 'published')
      throw new Error('Video is not available');
    return result;
  }
  async list(actor = '', topic = 'All', studio = false) {
    const address = actor ? this.chain.address(actor) : '';
    const rows = await Promise.all(
      this.chain.state.shorts.map(async (s) => {
        return this.describe(s, address, studio);
      }),
    );
    return rows
      .filter((s) =>
        studio
          ? s.mine
          : s.publicationStatus === 'published' &&
            s.guidelines.status === 'eligible',
      )
      .sort((a, b) => {
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
    if (
      !title?.trim() ||
      title.length > 100 ||
      !TOPICS.slice(1).includes(topic)
    )
      throw new Error('Provide a title and a supported topic');
    if (this.chain.state.shorts.length >= 50)
      throw new Error('Local preview is limited to 50 videos');
    if (
      this.chain.state.shorts.filter(
        (s) => s.creator === actor && s.createdAt > Date.now() - 3600000,
      ).length >= 10
    )
      throw new Error('Limit of 10 uploads per hour reached');
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
    const existing = this.chain.state.shorts.find(
      (s) => s.id === id && s.creator === actor,
    );
    if (existing) return existing;
    const prepared = await this.media.prepare(
      id,
      data,
      title.trim(),
      topic,
      details,
    );
    const short = {
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
    this.chain.state.shorts.unshift(short);
    await this.chain.save();
    return short;
  }
  async moderate(
    id: string,
    approve: boolean,
    reason = '',
    topic?: string,
    visualConfirmed = false,
  ) {
    const short = this.item(id);
    if (topic && !TOPICS.slice(1).includes(topic))
      throw new Error('Choose a supported review topic');
    if (typeof reason !== 'string' || reason.length > 1000)
      throw new Error('Invalid review reason');
    if (approve) {
      if (!short.safety || ['blocked', 'error'].includes(short.safety.status))
        throw new Error(
          'A completed visual scan without a blocking flag is required before approval',
        );
      if (
        short.safety.status === 'review' &&
        (!visualConfirmed || reason.trim().length < 10)
      )
        throw new Error(
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
    await this.chain.save();
    return { status: short.moderation };
  }
  async rescan(id: string) {
    const short = this.item(id);
    // Keep prior evidence intact so disabling demo mode restores review state.
    if (this.demoAutoApprove) return short.safety;
    short.safety = await this.media.rescan(short);
    short.visualReviewHash = undefined;
    if (short.safety?.status !== 'no_flags') {
      short.moderation =
        short.safety?.status === 'blocked' ? 'rejected' : 'pending';
      short.reviewReason = short.safety?.reason;
    }
    await this.chain.save();
    return short.safety;
  }
  async publish(actor: string, id: string) {
    const short = this.item(id);
    if (short.creator !== this.chain.address(actor))
      throw new Error('Only the creator can publish this Short');
    const existing = await this.chain.read('get_short', [id]);
    if (existing?.withdrawn || short.publication === 'withdrawn')
      throw new Error('Withdrawn Shorts cannot be published');
    if (!existing) {
      // Persist intent first: a restart or lost response must resume the same ID.
      short.publication = 'pending';
      await this.chain.save();
      await this.media.pin(short);
      await this.chain.write('publish', [
        id,
        short.creator,
        short.cid,
        short.bytes,
      ]);
    }
    short.publication = 'published';
    await this.chain.save();
    this.streaming?.enqueue(id);
    return this.describe(short, actor, true);
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
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new NotFoundException();
    const short = this.chain.state.shorts.find((entry) => entry.id === id);
    if (!short || short.publication === 'withdrawn')
      throw new NotFoundException();
    const published = await this.chain.read('get_short', [id]);
    if (
      !published ||
      published.withdrawn ||
      published.cid !== short.cid ||
      published.creator !== short.creator ||
      BigInt(published.size) !== BigInt(short.bytes)
    )
      throw new NotFoundException('Video unavailable');
    // Existing policy: published videos may be shared with a content warning;
    // feed eligibility remains separate. Private drafts never have a descriptor.
    return {
      id: short.id,
      cid: short.cid,
      files: short.files.filter((file) =>
        ['video.mp4', 'poster.jpg', 'captions.vtt'].includes(file.name),
      ),
    };
  }
  async ensurePlayable(id: string) {
    const s = this.item(id);
    const v = await this.chain.read('get_short', [id]);
    if (!v || v.withdrawn) throw new Error('Video is not available');
    return s;
  }
  async appeal(actor: string, id: string, message: string) {
    const s = this.item(id);
    if (s.creator !== actor || s.moderation !== 'rejected')
      throw new Error('Only the creator of restricted content can appeal');
    if (
      typeof message !== 'string' ||
      message.trim().length < 10 ||
      message.length > 1000
    )
      throw new Error('Explain your appeal in 10–1000 characters');
    if (s.appeal?.status === 'pending')
      throw new Error('Your appeal is already awaiting review');
    s.appeal = { message: message.trim(), at: Date.now(), status: 'pending' };
    await this.chain.save();
    return { status: 'pending' };
  }
  async report(
    id: string,
    body: { id: string; reason: string; detail?: string },
  ) {
    const s = this.item(id);
    if (
      !body ||
      !/^[a-zA-Z0-9-]{20,80}$/.test(body.id) ||
      !['Safety', 'Harassment', 'Copyright', 'Spam', 'Other'].includes(
        body.reason,
      ) ||
      (body.detail !== undefined && typeof body.detail !== 'string') ||
      (body.detail?.length || 0) > 1000
    )
      throw new Error('Choose a reason and keep details under 1000 characters');
    s.reportDetails ||= [];
    if (s.reportDetails.some((r) => r.id === body.id))
      return { received: true };
    if (s.reportDetails.length >= 1000)
      throw new Error('This video already has a full review queue');
    s.reportDetails.push({
      ...body,
      detail: body.detail || '',
      at: Date.now(),
    });
    s.reports++;
    await this.chain.save();
    return { received: true };
  }
  async performance(actor: string, days: number, shortId?: string) {
    if (![7, 28, 90].includes(days)) throw new Error('Choose 7, 28 or 90 days');
    const own = this.chain.state.shorts.filter((s) => s.creator === actor);
    if (shortId && !own.some((s) => s.id === shortId))
      throw new Error('Creator access required');
    const analytics = this.analytics.report(
      own.filter((s) => !shortId || s.id === shortId).map((s) => s.id),
      days,
    );
    const finance = this.ledger.report(
      actor,
      analytics.start,
      analytics.end,
      shortId,
    );
    const previousFinance = this.ledger.report(
      actor,
      analytics.start - days * 86400000,
      analytics.start,
      shortId,
    );
    return {
      ...analytics,
      finance,
      previousFinance: {
        earned: previousFinance.earned,
        paidLikes: previousFinance.paidLikes,
      },
      generatedAt: Date.now(),
    };
  }
  async dashboard(actor: DemoActor) {
    const account = await this.chain.account(actor);
    const shorts = await this.list(actor, 'All', true);
    const receipts = this.chain.state.receipts.filter((r) => r.actor === actor);
    return {
      account,
      shorts,
      receipts: receipts.slice(0, 15),
      totalViews: shorts.reduce((n, s) => n + s.views, 0),
      totalLikes: shorts.reduce((n, s) => n + s.likes, 0),
    };
  }
}
