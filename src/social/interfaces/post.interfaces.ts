import { ITransaction } from '@/utils/types';
import { Topic } from '../entities/topic.entity';

/**
 * Configuration for a post contract
 */
export interface IPostContract {
  contractAddress: string;
  version: number;
  description?: string;
}

/**
 * Parsed post content with extracted metadata
 */
export interface IParsedPostContent {
  content: string;
  topics: string[];
  media: string[];
}

/**
 * Data structure for creating a new post
 */
export interface ICreatePostData {
  id: string;
  slug: string;
  type: string;
  tx_hash: string;
  sender_address: string;
  contract_address: string;
  content: string;
  topics: Topic[];
  media: string[];
  total_comments: number;
  tx_args: any[];
  created_at: Date;
  post_id?: string;
  is_hidden?: boolean;
  version?: number;
}

/**
 * Result of post processing operation
 */
export interface IPostProcessingResult {
  success: boolean;
  post?: any;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * Configuration for middleware API requests
 */
export interface IMiddlewareRequestConfig {
  direction: 'forward' | 'backward';
  limit: number;
  type: string;
  contract: string;
}

/**
 * Response structure from middleware API
 */
export interface IMiddlewareResponse {
  data: ITransaction[];
  next?: string;
  prev?: string;
}

/**
 * Options for content parsing
 */
export interface IContentParsingOptions {
  maxTopics?: number;
  maxMediaItems?: number;
  sanitizeContent?: boolean;
}

/**
 * Comment detection result
 */
export interface ICommentInfo {
  isComment: boolean;
  parentPostId?: string;
  commentArgument?: any;
}

export interface IPostTypeInfo {
  isComment?: boolean;
  parentPostId?: string;
  isBclSale?: boolean;
  isBclTx?: boolean;
  isBclGain?: boolean;
  isHidden?: boolean;
}

/**
 * Comment processing result
 */
export interface ICommentProcessingResult {
  success: boolean;
  parentPostExists?: boolean;
  error?: string;
}
