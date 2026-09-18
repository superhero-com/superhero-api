import { Controller, Get, Render, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AffiliationAnalyticsGuard } from '../guards/affiliation-analytics.guard';
import { BclAffiliationTreeService } from '../services/bcl-affiliation-tree.service';

// Same operator key as the analytics dashboards: the invite tree is the same
// wallet-level graph, just drawn differently.
@Controller('bcl-affiliation/tree')
@ApiTags('BCL-Affiliation')
@ApiSecurity('affiliation-analytics-key')
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
