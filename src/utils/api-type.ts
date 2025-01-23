import { Pagination } from 'nestjs-typeorm-paginate';
import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

export const ApiOkResponsePaginated = <DataDto extends Type<unknown>>(
  dataDto: DataDto,
) =>
  applyDecorators(
    ApiExtraModels(Pagination, dataDto),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(Pagination) },
          {
            properties: {
              items: {
                type: 'array',
                items: { $ref: getSchemaPath(dataDto) },
              },
              meta: {
                type: 'object',
                properties: {
                  itemCount: {
                    type: 'number',
                  },
                  totalItems: {
                    type: 'number',
                  },
                  itemsPerPage: {
                    type: 'number',
                  },
                  totalPages: {
                    type: 'number',
                  },
                  currentPage: {
                    type: 'number',
                  },
                },
                required: [
                  'itemCount',
                  'totalItems',
                  'itemsPerPage',
                  'totalPages',
                  'currentPage',
                ],
              },
              links: {
                type: 'object',
                properties: {
                  first: {
                    type: 'string',
                  },
                  previous: {
                    type: 'string',
                  },
                  next: {
                    type: 'string',
                  },
                  last: {
                    type: 'string',
                  },
                },
              },
            },
            required: ['items', 'meta'],
          },
        ],
      },
    }),
  );
