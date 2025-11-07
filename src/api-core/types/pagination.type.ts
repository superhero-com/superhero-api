import { Field, ObjectType, Int } from '@nestjs/graphql';

type ClassType<T = any> = new (...args: any[]) => T;

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

export function PaginatedResponse<TItem>(TItemClass: ClassType<TItem>) {
  const className = TItemClass.name;
  const typeName = `Paginated${className}Response`;

  @ObjectType(typeName, { isAbstract: true })
  abstract class PaginatedResponseClass {
    @Field(() => [TItemClass])
    items: TItem[];

    @Field(() => PaginationMeta)
    metaInfo: PaginationMeta;
  }
  return PaginatedResponseClass;
}

