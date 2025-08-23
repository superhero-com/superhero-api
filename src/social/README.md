# Social Posts Module

This module handles social media posts on the Aeternity blockchain, including post creation, content parsing, and data retrieval.

## Overview

The Social Posts module processes blockchain transactions to extract and store social media posts. It supports multiple contract versions and provides comprehensive content parsing, media extraction, and topic analysis.

## Architecture

### Core Components

- **PostService**: Main service handling post processing and storage
- **Post Entity**: Database entity representing social posts
- **PostsController**: REST API endpoints for post retrieval
- **Content Parser**: Utility for parsing post content and extracting metadata
- **Contract Configuration**: Centralized contract management

### Key Features

- ✅ Multi-contract support with versioning
- ✅ Real-time transaction processing
- ✅ Content sanitization and validation
- ✅ Topic extraction (hashtags)
- ✅ Media URL validation and extraction
- ✅ Comprehensive error handling and logging
- ✅ Database transaction safety
- ✅ Retry mechanisms for API failures
- ✅ Concurrent processing with locks

## Configuration

### Contract Configuration

Contracts are configured in `src/social/config/post-contracts.config.ts`:

```typescript
export const POST_CONTRACTS: IPostContract[] = [
  {
    contractAddress: 'ct_2Hyt9ZxzXra5NAzhePkRsDPDWppoatVD7CtHnUoHVbuehwR8Nb',
    version: 3,
    description: 'Current social posting contract'
  },
];
```

### Content Parsing Options

Content parsing can be customized via `IContentParsingOptions`:

- `maxTopics`: Maximum number of hashtags to extract (default: 10)
- `maxMediaItems`: Maximum number of media URLs to extract (default: 5)
- `sanitizeContent`: Whether to sanitize content (default: true)

## API Endpoints

### GET /posts

Retrieve paginated list of posts with optional sorting.

**Query Parameters:**
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 100)
- `order_by`: Sort field ('total_comments' | 'created_at')
- `order_direction`: Sort direction ('ASC' | 'DESC')

### GET /posts/:id

Retrieve a specific post by ID.

## Data Processing Flow

1. **Transaction Reception**: Live transactions or batch processing from middleware
2. **Contract Validation**: Check if transaction is from supported contract
3. **Content Extraction**: Extract content and metadata from transaction arguments
4. **Content Parsing**: Parse content for topics and media URLs
5. **Validation**: Validate content structure and data integrity
6. **Storage**: Save to database with transaction safety
7. **Error Handling**: Log errors and handle failures gracefully

## Content Processing

### Topic Extraction

- Extracts hashtags starting with '#'
- Converts to lowercase
- Filters invalid characters
- Removes duplicates
- Limits to reasonable length (1-50 characters)

### Media Validation

- Validates URL format and protocol (http/https)
- Checks for common media file extensions
- Supports major media hosting platforms
- Limits number of media items per post

### Content Sanitization

- Trims whitespace
- Normalizes line endings
- Limits consecutive line breaks
- Enforces maximum content length (5000 chars)

## Error Handling

The module implements comprehensive error handling:

- **Validation Errors**: Invalid transaction data or content
- **Network Errors**: Middleware API failures with retry logic
- **Database Errors**: Transaction rollback and error logging
- **Processing Errors**: Individual transaction failures don't stop batch processing

## Monitoring and Logging

Structured logging provides visibility into:

- Transaction processing status
- Error details with stack traces
- Performance metrics
- Contract processing statistics
- Retry attempts and failures

## Development

### Running Tests

```bash
npm test src/social
```

### Adding New Contracts

1. Add contract configuration to `post-contracts.config.ts`
2. Update contract version handling if needed
3. Test with sample transactions

### Extending Content Parsing

1. Modify `content-parser.util.ts`
2. Add new parsing options to interfaces
3. Update tests and documentation

## Performance Considerations

- **Concurrent Processing**: Uses processing locks to prevent duplicate work
- **Batch Processing**: Processes multiple transactions efficiently
- **Database Transactions**: Ensures data consistency
- **Error Isolation**: Individual failures don't affect batch processing
- **Retry Logic**: Handles temporary network failures gracefully

## Security

- **Input Validation**: All transaction data is validated
- **Content Sanitization**: User content is sanitized before storage
- **URL Validation**: Media URLs are validated for security
- **Error Information**: Sensitive data is not logged in errors
