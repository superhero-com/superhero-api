import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
@Module({
  imports: [TypeOrmModule.forFeature([])],
  providers: [],
  exports: [],
  controllers: [],
})
export class MdwModule {
  //
}
