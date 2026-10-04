import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService, SHORTS_TOPICS } from './shorts-labels.service';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ShortsChainService, ae, aetto } from './shorts-chain.service';
import { ShortsMediaService } from './shorts-media.service';
import { DemoActor, FundingSource, ShortRecord } from './shorts.types';
import { communityGuidelines, creatorContent } from './shorts-eligibility';

export const TOPICS = ['All', ...SHORTS_TOPICS];
@Injectable()
export class ShortsService {
  constructor(
    readonly chain: ShortsChainService,
    readonly media: ShortsMediaService,
    readonly analytics: ShortsAnalyticsService,
    readonly ledger: ShortsLedgerService,
    readonly labels: ShortsLabelsService,
  ) {}
  item(id: string) {
    const item = this.chain.state.shorts.find((s) => s.id === id);
    if (!item) throw new Error('Short not found');
    return item;
  }
  async config() {
    return {
      mode: 'testnet',
      network: 'ae_uat',
      contract: this.chain.state.contract,
      likeFee: '0.1',
      creatorShare: 80,
      treasuryShare: 20,
      ipfs: await this.media.health(),
      replicas: this.media.apis.length,
      visualModeration: await this.media.safety.health(),
      classification: 'Local frame inspection + human review',
      analyticsSince: this.analytics.since,
      topics: TOPICS,
      operator: this.chain.operator.address,
      aci: this.chain.artifact.aci,
      bytecodeHash: this.chain.artifact.bytecodeHash,
    };
  }
  private async describe(s: ShortRecord, address = '', studio = false) {
    const v = await this.chain.read('get_short', [s.id]);
    const hostingStatus = !v
      ? 'unfunded'
      : v.withdrawn
        ? 'withdrawn'
        : BigInt(v.until) <= BigInt(Date.now())
          ? 'expired'
          : 'active';
    const guidelines = communityGuidelines(s);
    const status =
      hostingStatus === 'withdrawn'
        ? 'withdrawn'
        : guidelines.status === 'ineligible'
          ? 'rejected'
          : guidelines.status !== 'eligible'
            ? 'pending'
            : hostingStatus === 'unfunded'
              ? 'ready'
              : hostingStatus;
    return {
      ...creatorContent(s),
      appeal: studio ? s.appeal : undefined,
      captionsUrl: s.captions
        ? `/api/shorts/media/${s.id}/captions.vtt`
        : undefined,
      views: s.views.length,
      status,
      hostingStatus,
      contentWarning:
        guidelines.status === 'eligible'
          ? undefined
          : guidelines.status === 'ineligible'
            ? 'feed-excluded'
            : 'unreviewed',
      until: v ? Number(v.until) : 0,
      likes: v ? Number(v.likes) : 0,
      liked:
        v && address
          ? await this.chain.read('has_liked', [address, s.id])
          : false,
      mine: s.creator === address,
      videoUrl: `/api/shorts/media/${s.id}/video.mp4`,
      posterUrl: `/api/shorts/media/${s.id}/poster.jpg`,
    };
  }
  async shared(id: string, actor = '') {
    const short = await this.ensurePlayable(id);
    const result = await this.describe(
      short,
      actor ? this.chain.address(actor) : '',
    );
    if (result.hostingStatus !== 'active')
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
          : s.hostingStatus === 'active' && s.guidelines.status === 'eligible',
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
      classification: await this.labels.classify({
        title: title.trim(),
        topic,
        description: details.description,
        captions: details.captions,
      }),
      moderation:
        prepared.safety.status === 'blocked'
          ? ('rejected' as const)
          : ('pending' as const),
      reviewReason: prepared.safety.reason,
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
    short.safety = await this.media.rescan(short);
    short.visualReviewHash = undefined;
    if (short.safety.status !== 'no_flags') {
      short.moderation =
        short.safety.status === 'blocked' ? 'rejected' : 'pending';
      short.reviewReason = short.safety.reason;
    }
    await this.chain.save();
    return short.safety;
  }
  async hostingPrices(actor: DemoActor, id: string) {
    const short = this.item(id);
    if (short.creator !== this.chain.address(actor))
      throw new Error('Only the creator can price this Short');
    const cfg = await this.chain.read('get_config');
    return {
      shortId: id,
      bytes: short.bytes,
      numerator: String(cfg[4]),
      denominator: String(cfg[5]),
      maxDays: 3650,
    };
  }
  async quote(
    actor: DemoActor,
    id: string,
    budget: string | undefined,
    source: FundingSource,
    requestedDays?: number,
  ) {
    const s = this.item(id);
    if (s.creator !== this.chain.address(actor))
      throw new Error('Only the creator can fund this Short');
    if (!['wallet', 'rewards'].includes(source))
      throw new Error('Unknown funding source');
    if ((budget !== undefined) === (requestedDays !== undefined))
      throw new Error('Choose a hosting duration or an AE budget');
    if (
      requestedDays !== undefined &&
      (!Number.isInteger(requestedDays) ||
        requestedDays < 1 ||
        requestedDays > 3650)
    )
      throw new Error('Choose between 1 and 3650 whole days');
    const cfg = await this.chain.read('get_config');
    const n = BigInt(cfg[4]),
      d = BigInt(cfg[5]);
    const affordable =
      requestedDays !== undefined
        ? BigInt(requestedDays)
        : (aetto(budget!) * d) / (BigInt(s.bytes) * n);
    const days = affordable > 3650n ? 3650n : affordable;
    if (days < 1n) throw new Error('Budget must cover at least one day');
    const v = await this.chain.read('get_short', [id]);
    if (v?.withdrawn) throw new Error('Withdrawn Shorts cannot be funded');
    const result = await this.chain.write('register_quote', [
      id,
      s.creator,
      s.cid,
      s.bytes,
      days.toString(),
      v?.until ?? 0,
      source === 'rewards',
    ]);
    const qid = String(result.decodedResult);
    const q = await this.chain.read('get_quote', [qid]);
    return {
      id: qid,
      shortId: id,
      title: s.title,
      bytes: s.bytes,
      days: Number(days),
      source,
      charge: ae(q.amount),
      unused: budget === undefined ? '0' : ae(aetto(budget) - BigInt(q.amount)),
      amountAettos: String(q.amount),
      daily: ae((BigInt(s.bytes) * n + d - 1n) / d),
      previousUntil: Number(q.expected_until),
      estimatedUntil:
        Math.max(Date.now(), Number(q.expected_until)) +
        Number(days) * 86400000,
      expiresAt: Number(q.expires),
      rateVersion: Number(q.rate_version),
    };
  }
  async fund(actor: string, quoteId: string) {
    const q = await this.chain.read('get_quote', [quoteId]);
    const short = this.item(q.video_id);
    if (q.creator !== actor || short.creator !== actor)
      throw new Error('Only the creator can activate hosting');
    if (q.complete) {
      // A refund also finalizes a quote; only a tranche proves activation.
      await this.chain.read('get_tranche', [quoteId]);
      return { message: 'Hosting was already activated' };
    }
    if (!q.funded)
      throw new Error('Confirm the hosting transaction in your wallet first');
    if (Number(q.deadline) < Date.now())
      throw new Error(
        'Activation deadline passed; claim the failed-purchase refund in your wallet',
      );
    await this.media.pin(short);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.chain.write('activate', [quoteId]);
        return {
          tx: r.hash,
          message: 'Hosting activated after verified IPFS retrieval',
        };
      } catch (error) {
        // A node can briefly disagree with the preceding funded-state read.
        // Retry only this explicit rejected operator activation, never wallet payments.
        if (
          !(error instanceof Error) ||
          !error.message.includes('ACTIVATION_UNAVAILABLE') ||
          attempt === 2
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const latest = await this.chain.read('get_quote', [quoteId]);
        if (latest.complete) {
          await this.chain.read('get_tranche', [quoteId]);
          return { message: 'Hosting was already activated' };
        }
        if (!latest.funded || Number(latest.deadline) < Date.now()) throw error;
      }
    }
    throw new Error(
      'Activation remains pending; recovery will retry without another payment',
    );
  }
  async view(id: string, session: string) {
    const s = this.item(id);
    if (!/^[a-zA-Z0-9-]{10,80}$/.test(session))
      throw new Error('Invalid session');
    await this.ensurePlayable(id);
    if (!s.views.includes(session) && s.views.length < 10000) {
      s.views.push(session);
      await this.chain.save();
    }
    return { views: s.views.length };
  }
  async ensurePlayable(id: string) {
    const s = this.item(id);
    const v = await this.chain.read('get_short', [id]);
    if (!v || v.withdrawn || BigInt(v.until) <= BigInt(Date.now()))
      throw new Error('Video is not available');
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
    const pending = [];
    for (const short of shorts) {
      const id = await this.chain.read('get_pending', [short.id]);
      if (id !== undefined) {
        const q = await this.chain.read('get_quote', [id]);
        if (q.funded && !q.complete)
          pending.push({
            id: String(id),
            shortId: q.video_id,
            deadline: Number(q.deadline),
            refundable: Number(q.deadline) < Date.now(),
          });
      }
    }
    return {
      account,
      shorts,
      receipts: receipts.slice(0, 15),
      pending,
      totalViews: shorts.reduce((n, s) => n + s.views, 0),
      totalLikes: shorts.reduce((n, s) => n + s.likes, 0),
    };
  }
}
