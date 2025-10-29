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
import { Topic } from '../entities/topic.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

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

  @ApiParam({ name: 'id', type: 'string', description: 'Topic ID' })
  @ApiOperation({
    operationId: 'getTopicById',
    summary: 'Get topic by ID',
    description: 'Retrieve a specific topic by its unique identifier',
  })
  @ApiOkResponse({
    type: Topic,
    description: 'Topic retrieved successfully',
  })
  @Get(':id')
  async getById(@Param('id') id: string) {
    const topic = await this.topicRepository.findOne({
      where: { id },
      relations: ['posts'],
    });
    if (!topic) {
      throw new NotFoundException(`Topic with ID ${id} not found`);
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
  async getByName(@Param('name') name: string) {
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
    return this.topicRepository
      .createQueryBuilder('topic')
      .orderBy('topic.post_count', 'DESC')
      .limit(limit)
      .getMany();
  }
}
