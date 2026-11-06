import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';

// Allows one nested list at full page size (keyBlocks { txs } = 11,100) but
// not a list under a list under a list.
export const MAX_QUERY_COMPLEXITY = 15_000;
// Introspection is ~190 tokens; this bounds aliases of zero-cost scalars.
export const MAX_QUERY_TOKENS = 2_000;

// Not ApolloServerPlugin from @apollo/server: ts-jest resolves its ESM
// declarations, which don't match the driver's CJS ones.
type ApolloPlugin = NonNullable<ApolloDriverConfig['plugins']>[number];

function badRequest(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: 'BAD_REQUEST', http: { status: 400 } },
  });
}

const queryComplexityPlugin: ApolloPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ request, document, schema }) {
        let complexity: number;
        try {
          complexity = getComplexity({
            schema,
            operationName: request.operationName,
            query: document,
            variables: request.variables,
            // Only fields that declare a cost (relations, lists) count.
            estimators: [
              fieldExtensionsEstimator(),
              simpleEstimator({ defaultComplexity: 0 }),
            ],
          });
        } catch (error: any) {
          throw badRequest(error.message);
        }
        if (complexity > MAX_QUERY_COMPLEXITY) {
          throw badRequest(
            `Query complexity ${complexity} exceeds the maximum of ${MAX_QUERY_COMPLEXITY}`,
          );
        }
      },
    };
  },
};

/** Apollo options to spread into GraphQLModule.forRoot. */
export const QUERY_LIMIT_OPTIONS = {
  parseOptions: { maxTokens: MAX_QUERY_TOKENS },
  plugins: [queryComplexityPlugin],
};
