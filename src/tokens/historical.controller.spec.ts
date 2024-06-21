import { Test, TestingModule } from '@nestjs/testing';
import { HistoricalController } from './historical.controller';

describe('HistoricalController', () => {
  let controller: HistoricalController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HistoricalController],
    }).compile();

    controller = module.get<HistoricalController>(HistoricalController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
