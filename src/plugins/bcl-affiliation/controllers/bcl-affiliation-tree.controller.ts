import { Controller, Get, Render } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BclAffiliationTreeService } from '../services/bcl-affiliation-tree.service';

@Controller('bcl-affiliation/tree')
@ApiTags('BCL-Affiliation')
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


