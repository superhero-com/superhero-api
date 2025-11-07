import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { EntityConfig } from '../types/entity-config.interface';

export function createBaseController<T>(config: EntityConfig<T>) {
  @Controller(config.routePrefix)
  @ApiTags(config.swaggerTag)
  class BaseController {
    constructor(
      @InjectRepository(config.entity)
      public readonly repository: Repository<T>,
    ) {}

    @ApiQuery({ name: 'page', type: 'number', required: false })
    @ApiQuery({ name: 'limit', type: 'number', required: false })
    @ApiQuery({
      name: 'order_by',
      enum: config.orderByFields,
      required: false,
    })
    @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
    @ApiOperation({
      operationId: `listAll${config.queryNames.plural}`,
      summary: `Get all ${config.queryNames.plural}`,
      description: `Retrieve a paginated list of all ${config.queryNames.plural} with optional sorting`,
    })
    @ApiOkResponsePaginated(config.entity)
    @Get()
    async listAll(
      @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
      @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
      @Query('order_by') orderBy: string = config.defaultOrderBy,
      @Query('order_direction')
      orderDirection: 'ASC' | 'DESC' = config.defaultOrderDirection || 'DESC',
    ) {
      const query = this.repository.createQueryBuilder(config.tableAlias);

      if (orderBy) {
        query.orderBy(`${config.tableAlias}.${orderBy}`, orderDirection);
      }

      const result = await paginate(query, { page, limit });
      return {
        items: result.items,
        metaInfo: result.meta,
      };
    }

    @ApiParam({
      name: config.primaryKey,
      type: 'string',
      description: `${config.queryNames.singular} ${config.primaryKey}`,
    })
    @ApiOperation({
      operationId: `get${config.queryNames.singular}By${config.primaryKey.charAt(0).toUpperCase() + config.primaryKey.slice(1)}`,
      summary: `Get ${config.queryNames.singular} by ${config.primaryKey}`,
      description: `Retrieve a specific ${config.queryNames.singular} by its ${config.primaryKey}`,
    })
    @ApiOkResponse({
      type: config.entity,
      description: `${config.queryNames.singular} retrieved successfully`,
    })
    @Get(`:${config.primaryKey}`)
    async findOne(@Param(config.primaryKey) id: string) {
      const entity = await this.repository.findOne({
        where: { [config.primaryKey]: id } as any,
      });

      if (!entity) {
        throw new NotFoundException(
          `${config.queryNames.singular} with ${config.primaryKey} "${id}" not found`,
        );
      }

      return entity;
    }
  }

  return BaseController;
}

