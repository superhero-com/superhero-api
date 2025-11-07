import { Field, ObjectType, Int } from '@nestjs/graphql';

@ObjectType()
export class PaginationMeta {
  @Field(() => Int)
  itemCount: number;

  @Field(() => Int)
  totalItems: number;

  @Field(() => Int)
  itemsPerPage: number;

  @Field(() => Int)
  totalPages: number;

  @Field(() => Int)
  currentPage: number;
}

@ObjectType()
export class PaginationLinks {
  @Field(() => String, { nullable: true })
  first?: string;

  @Field(() => String, { nullable: true })
  previous?: string;

  @Field(() => String, { nullable: true })
  next?: string;

  @Field(() => String, { nullable: true })
  last?: string;
}

