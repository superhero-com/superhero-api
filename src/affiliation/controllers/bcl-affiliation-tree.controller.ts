import { Controller, Get, Render, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AffiliationAnalyticsGuard } from '../guards/affiliation-analytics.guard';
import { BclAffiliationTreeService } from '../services/bcl-affiliation-tree.service';

// Same operator login as the analytics dashboards: the invite tree is the same
// wallet-level graph, just drawn differently.
@Controller('bcl-affiliation/tree')
@ApiTags('BCL-Affiliation')
@UseGuards(AffiliationAnalyticsGuard)
export class BclAffiliationTreeController {
  constructor(private readonly treeService: BclAffiliationTreeService) {}

  @Get('')
  @ApiOperation({ operationId: 'getBclAffiliationTreeData' })
  async getTreeData() {
    return this.treeService.getTreeData();
  }

  @Get('preview')
  @Render('bcl-affilation-tree')
  @ApiOperation({ operationId: 'previewBclAffiliationTree' })
  preview() {
    return { message: 'Hello world!' };
  }
}
