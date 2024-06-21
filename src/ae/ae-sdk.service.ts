import { AeSdk, CompilerHttp } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { nodes } from './config';
import { ACTIVE_NETWORK } from './utils/networks';

@Injectable()
export class AeSdkService {
  sdk: AeSdk;
  constructor() {
    this.sdk = new AeSdk({
      onCompiler: new CompilerHttp('https://v7.compiler.aepps.com'),
      nodes,
    });

    this.sdk.selectNode(ACTIVE_NETWORK.name);
  }
}
