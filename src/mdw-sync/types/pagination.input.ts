import { Field, InputType, Int } from '@nestjs/graphql';

@InputType()
export class PaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 1 })
  page?: number = 1;

  @Field(() => Int, { nullable: true, defaultValue: 100 })
  limit?: number = 100;

  @Field(() => String, { nullable: true })
  orderBy?: string;

  @Field(() => String, { nullable: true })
  orderDirection?: 'ASC' | 'DESC';
}

