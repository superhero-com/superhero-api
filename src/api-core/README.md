# API Core - Dynamic API Generation System

A powerful, reusable system for automatically generating REST API endpoints and GraphQL resolvers from TypeORM entities with built-in support for pagination, sorting, and filtering.

## Overview

The API Core module provides a declarative way to expose your entities as REST APIs and GraphQL queries. By simply decorating your entity properties and providing a configuration object, you get:

- ✅ **REST API endpoints** with pagination, sorting, and filtering
- ✅ **GraphQL queries** with pagination and sorting
- ✅ **Automatic Swagger documentation** for all endpoints
- ✅ **Type-safe** query parameters and responses
- ✅ **Customizable** filtering logic per field

## Table of Contents

- [Quick Start](#quick-start)
- [Decorators](#decorators)
  - [@Sortable()](#sortable)
  - [@Searchable()](#searchable)
- [Entity Configuration](#entity-configuration)
- [Base Controller](#base-controller)
- [Base Resolver](#base-resolver)
- [Factory Functions](#factory-functions)
- [Complete Examples](#complete-examples)
- [Best Practices](#best-practices)

## Quick Start

### 1. Decorate Your Entity

```typescript
import { Entity, Column, PrimaryColumn } from 'typeorm';
import { ObjectType, Field } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { Sortable } from '@/api-core/decorators/sortable.decorator';
import { Searchable } from '@/api-core/decorators/searchable.decorator';

@Entity({ name: 'users' })
@ObjectType()
export class User {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable({ description: 'User identifier' })
  @Searchable({ description: 'Filter by user ID' })
  id: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable({ description: 'Filter by username (exact match)' })
  username: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  email: string;
}
```

### 2. Create Entity Configuration

```typescript
import { EntityConfig } from '@/api-core/types/entity-config.interface';
import { User } from './entities/user.entity';

export const USER_CONFIG: EntityConfig<User> = {
  entity: User,
  primaryKey: 'id',
  defaultOrderBy: 'username',
  defaultOrderDirection: 'ASC',
  tableAlias: 'user',
  routePrefix: 'v1/users',
  queryNames: {
    plural: 'users',
    singular: 'user',
  },
  swaggerTag: 'Users',
};
```

### 3. Generate Controllers and Resolvers

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createEntityControllers, createEntityResolvers } from '@/api-core/factories/entity-factory';
import { User } from './entities/user.entity';
import { USER_CONFIG } from './config/user.config';

const controllers = createEntityControllers([USER_CONFIG]);
const resolvers = createEntityResolvers([USER_CONFIG]);

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [...controllers],
  providers: [...resolvers],
})
export class UserModule {}
```

That's it! You now have:
- `GET /v1/users` - List all users with pagination, sorting, and filtering
- `GET /v1/users/:id` - Get a single user by ID
- GraphQL `users` query - Paginated list
- GraphQL `user` query - Single user by ID

## Decorators

### @Sortable()

Marks a field as sortable in API queries. Fields marked with `@Sortable()` can be used in the `order_by` query parameter.

#### Basic Usage

```typescript
@Sortable()
username: string;
```

#### With Description

```typescript
@Sortable({ description: 'Sort by creation date' })
created_at: Date;
```

#### String Shorthand

```typescript
@Sortable('Sort by username')
username: string;
```

### @Searchable()

Marks a field as searchable/filterable. Fields marked with `@Searchable()` automatically get query parameters in REST API and can be used for filtering.

#### Basic Usage (Exact Match)

```typescript
@Searchable()
type: string;
```

This creates a query parameter `?type=SpendTx` that filters using `WHERE type = 'SpendTx'`.

#### With Description

```typescript
@Searchable({ description: 'Filter by transaction type' })
type: string;
```

#### Custom Resolver

For advanced filtering logic (e.g., partial matching, case-insensitive search):

```typescript
@Searchable((qb, alias, field, value) => {
  qb.andWhere(`${alias}.${field} LIKE :${field}`, { 
    [field]: `%${value}%` 
  });
})
username: string;
```

#### Custom Resolver with Description

```typescript
@Searchable({
  resolver: (qb, alias, field, value) => {
    qb.andWhere(`LOWER(${alias}.${field}) LIKE LOWER(:${field})`, {
      [field]: `%${value}%`,
    });
  },
  description: 'Search by username (case-insensitive partial match)'
})
username: string;
```

#### Resolver Function Signature

```typescript
type SearchResolver = (
  queryBuilder: SelectQueryBuilder<any>,
  tableAlias: string,
  fieldName: string,
  searchValue: any,
) => void;
```

**Parameters:**
- `queryBuilder`: TypeORM QueryBuilder instance
- `tableAlias`: The table alias from your entity config
- `fieldName`: The name of the field being filtered
- `searchValue`: The value from the query parameter

## Entity Configuration

The `EntityConfig` interface defines how your entity is exposed:

```typescript
interface EntityConfig<TEntity> {
  entity: Type<TEntity>;                    // Your entity class
  dto?: Type<any>;                          // Optional DTO for responses
  primaryKey: string;                       // Primary key field name
  defaultOrderBy: string;                   // Default sort field
  defaultOrderDirection?: 'ASC' | 'DESC';   // Default sort direction
  tableAlias: string;                       // SQL table alias
  routePrefix: string;                      // REST API route prefix
  queryNames: {
    plural: string;                         // Plural name (e.g., 'users')
    singular: string;                       // Singular name (e.g., 'user')
  };
  swaggerTag: string;                       // Swagger tag for grouping
  orderByFields?: string[];                 // Optional: explicit sortable fields
  customResolveFields?: CustomResolveFieldConfig[]; // GraphQL custom fields
}
```

### Configuration Example

```typescript
export const TX_CONFIG: EntityConfig<Tx> = {
  entity: Tx,
  primaryKey: 'hash',
  defaultOrderBy: 'block_height',
  defaultOrderDirection: 'DESC',
  tableAlias: 'tx',
  routePrefix: 'v2/mdw/txs',
  queryNames: {
    plural: 'txs',
    singular: 'tx',
  },
  swaggerTag: 'MDW Transactions',
  orderByFields: [
    'hash',
    'block_height',
    'type',
    'created_at',
  ],
};
```

**Note:** If `orderByFields` is not provided, the system will automatically extract fields marked with `@Sortable()`.

## Base Controller

The `createBaseController()` function generates a REST API controller with:

- **GET `/routePrefix`** - List all entities (paginated, sortable, filterable)
- **GET `/routePrefix/:primaryKey`** - Get single entity by primary key

### Query Parameters

#### List Endpoint (`GET /routePrefix`)

- `page` (number, default: 1) - Page number
- `limit` (number, default: 100) - Items per page
- `order_by` (string) - Field to sort by (must be marked with `@Sortable()`)
- `order_direction` ('ASC' | 'DESC', default: 'DESC') - Sort direction
- `{field}` (string) - Filter by any field marked with `@Searchable()`

#### Example Requests

```bash
# Get first page, 10 items per page
GET /v1/users?page=1&limit=10

# Sort by username ascending
GET /v1/users?order_by=username&order_direction=ASC

# Filter by type
GET /v1/users?type=admin

# Combine filters
GET /v1/users?type=admin&order_by=username&page=1&limit=20
```

### Response Format

```json
{
  "items": [
    { "id": "1", "username": "alice", "email": "alice@example.com" },
    { "id": "2", "username": "bob", "email": "bob@example.com" }
  ],
  "metaInfo": {
    "itemCount": 2,
    "totalItems": 100,
    "itemsPerPage": 10,
    "totalPages": 10,
    "currentPage": 1
  }
}
```

## Base Resolver

The `createBaseResolver()` function generates GraphQL resolvers with:

- **Query `{ plural }`** - Paginated list query
- **Query `{ singular }`** - Single entity query

### GraphQL Query Example

```graphql
query {
  users(page: 1, limit: 10, orderBy: "username", orderDirection: ASC) {
    items {
      id
      username
      email
    }
    metaInfo {
      itemCount
      totalItems
      totalPages
      currentPage
    }
  }
}
```

**Note:** GraphQL filtering by searchable fields requires extending the base resolver and adding `@Args` decorators manually. See [Extending Base Resolver](#extending-base-resolver).

## Factory Functions

### createEntityController()

Creates a single controller from an entity config:

```typescript
import { createEntityController } from '@/api-core/factories/entity-factory';

const UserController = createEntityController(USER_CONFIG);
```

### createEntityResolver()

Creates a single resolver from an entity config:

```typescript
import { createEntityResolver } from '@/api-core/factories/entity-factory';

const UserResolver = createEntityResolver(USER_CONFIG);
```

### createEntityControllers()

Creates multiple controllers from an array of configs:

```typescript
import { createEntityControllers } from '@/api-core/factories/entity-factory';

const controllers = createEntityControllers([
  USER_CONFIG,
  POST_CONFIG,
  COMMENT_CONFIG,
]);
```

### createEntityResolvers()

Creates multiple resolvers from an array of configs:

```typescript
import { createEntityResolvers } from '@/api-core/factories/entity-factory';

const resolvers = createEntityResolvers([
  USER_CONFIG,
  POST_CONFIG,
]);
```

## Complete Examples

### Example 1: Simple Entity

```typescript
// entities/post.entity.ts
import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { Sortable } from '@/api-core/decorators/sortable.decorator';
import { Searchable } from '@/api-core/decorators/searchable.decorator';

@Entity({ name: 'posts' })
@ObjectType()
export class Post {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  id: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable({ description: 'Search posts by title' })
  title: string;

  @Column({ type: 'text' })
  @Field()
  @ApiProperty()
  content: string;

  @CreateDateColumn()
  @Field()
  @ApiProperty()
  @Sortable({ description: 'Sort by creation date' })
  created_at: Date;
}

// config/post.config.ts
import { EntityConfig } from '@/api-core/types/entity-config.interface';
import { Post } from '../entities/post.entity';

export const POST_CONFIG: EntityConfig<Post> = {
  entity: Post,
  primaryKey: 'id',
  defaultOrderBy: 'created_at',
  defaultOrderDirection: 'DESC',
  tableAlias: 'post',
  routePrefix: 'v1/posts',
  queryNames: {
    plural: 'posts',
    singular: 'post',
  },
  swaggerTag: 'Posts',
};

// post.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createEntityControllers, createEntityResolvers } from '@/api-core/factories/entity-factory';
import { Post } from './entities/post.entity';
import { POST_CONFIG } from './config/post.config';

@Module({
  imports: [TypeOrmModule.forFeature([Post])],
  controllers: [...createEntityControllers([POST_CONFIG])],
  providers: [...createEntityResolvers([POST_CONFIG])],
})
export class PostModule {}
```

### Example 2: Entity with Custom Filter

```typescript
// entities/product.entity.ts
@Entity({ name: 'products' })
@ObjectType()
export class Product {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  id: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable({
    resolver: (qb, alias, field, value) => {
      // Case-insensitive partial match
      qb.andWhere(`LOWER(${alias}.${field}) LIKE LOWER(:${field})`, {
        [field]: `%${value}%`,
      });
    },
    description: 'Search products by name (partial match)',
  })
  name: string;

  @Column({ type: 'decimal' })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable({
    resolver: (qb, alias, field, value) => {
      // Range filter: value format "min-max"
      const [min, max] = value.split('-').map(Number);
      if (max) {
        qb.andWhere(`${alias}.${field} BETWEEN :min AND :max`, { min, max });
      } else {
        qb.andWhere(`${alias}.${field} >= :min`, { min });
      }
    },
    description: 'Filter by price range (format: "min-max" or "min")',
  })
  price: number;
}
```

### Example 3: Extending Base Resolver

For GraphQL queries that need filtering, extend the base resolver:

```typescript
import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createBaseResolver } from '@/api-core/base/base.resolver';
import { EntityConfig } from '@/api-core/types/entity-config.interface';
import { Post } from './entities/post.entity';
import { POST_CONFIG } from './config/post.config';

const BasePostResolver = createBaseResolver(POST_CONFIG);

@Resolver(() => Post)
export class PostsResolver extends BasePostResolver {
  constructor(
    @InjectRepository(Post)
    public readonly repository: Repository<Post>,
  ) {
    super(repository);
  }

  // Override findAll to add filtering
  @Query(() => PaginatedPostResponse, { name: 'posts' })
  async findAll(
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number = 1,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })
    limit: number = 100,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
    @Args('title', { type: () => String, nullable: true })
    title?: string,
  ) {
    const query = this.repository.createQueryBuilder('post');

    // Apply filters
    if (title) {
      query.andWhere('post.title LIKE :title', { title: `%${title}%` });
    }

    // Apply ordering
    if (orderBy) {
      query.orderBy(`post.${orderBy}`, orderDirection || 'DESC');
    } else {
      query.orderBy('post.created_at', 'DESC');
    }

    const result = await paginate(query, { page, limit });
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }
}
```

## Best Practices

### 1. Use Descriptions

Always provide descriptions for better API documentation:

```typescript
@Sortable({ description: 'Sort by creation date (newest first)' })
@Searchable({ description: 'Filter by transaction type' })
```

### 2. Choose Appropriate Defaults

Set sensible defaults for ordering:

```typescript
{
  defaultOrderBy: 'created_at',
  defaultOrderDirection: 'DESC', // Most recent first
}
```

### 3. Use Custom Resolvers Sparingly

Only use custom resolvers when you need special logic. For most cases, the default exact match is sufficient:

```typescript
// Good: Simple exact match
@Searchable()
status: string;

// Good: Custom logic when needed
@Searchable({
  resolver: (qb, alias, field, value) => {
    qb.andWhere(`${alias}.${field} LIKE :${field}`, { [field]: `%${value}%` });
  },
  description: 'Partial match search',
})
name: string;
```

### 4. Group Related Entities

Keep entity configs together in a config file:

```typescript
// config/entity-configs.ts
export const USER_CONFIG: EntityConfig<User> = { ... };
export const POST_CONFIG: EntityConfig<Post> = { ... };
export const COMMENT_CONFIG: EntityConfig<Comment> = { ... };

export const ENTITY_CONFIGS = [
  USER_CONFIG,
  POST_CONFIG,
  COMMENT_CONFIG,
];
```

### 5. Use Meaningful Route Prefixes

Use versioned routes and clear prefixes:

```typescript
routePrefix: 'v1/users',        // ✅ Good
routePrefix: 'api/users',      // ✅ Good
routePrefix: 'users',           // ⚠️ Less clear
routePrefix: 'u',              // ❌ Bad
```

### 6. Consistent Naming

Use consistent naming conventions:

```typescript
queryNames: {
  plural: 'users',      // ✅ Plural form
  singular: 'user',     // ✅ Singular form
}
```

## Advanced Usage

### Custom DTOs

If you need to transform entity data for API responses:

```typescript
// dto/user.dto.ts
export class UserDto {
  id: string;
  username: string;
  // Exclude sensitive fields like password
}

// config/user.config.ts
export const USER_CONFIG: EntityConfig<User> = {
  entity: User,
  dto: UserDto,  // Use DTO instead of entity
  // ... rest of config
};
```

### Custom ResolveFields (GraphQL)

For entities with relationships, use `customResolveFields`:

```typescript
export const POST_CONFIG: EntityConfig<Post> = {
  // ... basic config
  customResolveFields: [
    {
      field: 'author',
      resolver: async (post) => {
        return userRepository.findOne({ where: { id: post.authorId } });
      },
      returnType: () => User,
    },
  ],
};
```

## Troubleshooting

### Fields Not Appearing in Swagger

- Ensure `@ApiProperty()` is on entity fields
- Check that `@Searchable()` decorator is applied
- Verify entity is registered with TypeORM

### Filtering Not Working

- Verify field is marked with `@Searchable()`
- Check that query parameter name matches field name exactly
- Ensure custom resolver (if used) is correctly implemented

### Sorting Not Working

- Verify field is marked with `@Sortable()`
- Check that `order_by` parameter matches field name exactly
- Ensure field exists in `orderByFields` or is marked with `@Sortable()`

## API Reference

### Exports

```typescript
// Decorators
export { Sortable, SortableOptions } from '@/api-core/decorators/sortable.decorator';
export { Searchable, SearchableOptions, SearchResolver } from '@/api-core/decorators/searchable.decorator';

// Types
export { EntityConfig, CustomResolveFieldConfig } from '@/api-core/types/entity-config.interface';
export { PaginatedResponse, PaginationMeta, PaginationLinks } from '@/api-core/types/pagination.type';

// Utilities
export { getSortableFields, getSearchableFields, SortableField, SearchableField } from '@/api-core/utils/metadata-reader';

// Factories
export { createEntityController, createEntityResolver, createEntityControllers, createEntityResolvers } from '@/api-core/factories/entity-factory';

// Base Classes (for extension)
export { createBaseController } from '@/api-core/base/base.controller';
export { createBaseResolver } from '@/api-core/base/base.resolver';
```

## License

This module is part of the application and follows the same license.

