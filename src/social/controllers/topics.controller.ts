import {
  BadRequestException,
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
import { Topic } from '../entities/topic.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { TopicParamPipe } from '@/common/validation/request-validation';

const ALLOWED_ORDER_BY = new Set(['name', 'post_count', 'created_at']);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);
const MAX_SEARCH_LENGTH = 100;

@Controller('topics')
@ApiTags('Topics')
export class TopicsController {
  constructor(
    @InjectRepository(Topic)
    private readonly topicRepository: Repository<Topic>,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['name', 'post_count', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search term to filter topics by name',
  })
  @ApiOperation({
    operationId: 'listAllTopics',
    summary: 'Get all topics',
    description:
      'Retrieve a paginated list of all topics with optional sorting and search functionality',
  })
  @ApiOkResponsePaginated(Topic)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('order_by') orderBy: string = 'post_count',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('search') search?: string,
  ) {
    if (page < 1) {
      throw new BadRequestException('Page must be greater than or equal to 1');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    if (!ALLOWED_ORDER_BY.has(orderBy)) {
      throw new BadRequestException(`Invalid order_by value: ${orderBy}`);
    }
    if (!ALLOWED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new BadRequestException(
        `Invalid order_direction value: ${orderDirection}`,
      );
    }
    if (search && search.length > MAX_SEARCH_LENGTH) {
      throw new BadRequestException(
        `search must be at most ${MAX_SEARCH_LENGTH} characters`,
      );
    }
    const query = this.topicRepository.createQueryBuilder('topic');

    // Add search functionality
    if (search) {
      const searchTerm = `%${search}%`;
      query.where('topic.name ILIKE :searchTerm', { searchTerm });
    }

    // Add ordering
    if (orderBy) {
      query.orderBy(`topic.${orderBy}`, orderDirection);
    }

    return paginate(query, { page, limit });
  }

  @ApiParam({ name: 'id', type: 'string', description: 'Topic ID or name' })
  @ApiOperation({
    operationId: 'getTopicById',
    summary: 'Get topic by ID or name',
    description:
      'Retrieve a specific topic by its unique identifier (UUID) or name',
  })
  @ApiOkResponse({
    type: Topic,
    description: 'Topic retrieved successfully',
  })
  @Get(':id')
  async getById(@Param('id', TopicParamPipe) id: string) {
    // Check if the parameter is a valid UUID format
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      );

    const topic = await this.topicRepository.findOne({
      where: isUUID ? { id } : { name: id },
      relations: ['posts'],
    });
    if (!topic) {
      throw new NotFoundException(
        `Topic with ${isUUID ? 'ID' : 'name'} "${id}" not found`,
      );
    }
    return topic;
  }

  @ApiParam({ name: 'name', type: 'string', description: 'Topic name' })
  @ApiOperation({
    operationId: 'getTopicByName',
    summary: 'Get topic by name',
    description: 'Retrieve a specific topic by its name',
  })
  @ApiOkResponse({
    type: Topic,
    description: 'Topic retrieved successfully',
  })
  @Get('name/:name')
  async getByName(@Param('name', TopicParamPipe) name: string) {
    const topic = await this.topicRepository.findOne({
      where: { name },
      relations: ['posts'],
    });
    if (!topic) {
      throw new NotFoundException(`Topic with name "${name}" not found`);
    }
    return topic;
  }

  @ApiOperation({
    operationId: 'getPopularTopics',
    summary: 'Get popular topics',
    description: 'Retrieve the most popular topics by post count',
  })
  @ApiOkResponse({
    type: [Topic],
    description: 'Popular topics retrieved successfully',
  })
  @Get('popular/trending')
  async getPopularTopics(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    return this.topicRepository
      .createQueryBuilder('topic')
      .orderBy('topic.post_count', 'DESC')
      .limit(limit)
      .getMany();
  }
}
