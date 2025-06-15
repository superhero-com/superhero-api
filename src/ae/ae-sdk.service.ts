import { AeSdk, CompilerHttp } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { ACTIVE_NETWORK, nodes } from '../configs';

@Injectable()
export class AeSdkService {
  sdk: AeSdk;
  constructor() {
    this.sdk = new AeSdk({
      onCompiler: new CompilerHttp('https://v7.compiler.aepps.com'),
      nodes,
      gasPrice: 1000000000000000000,
    });

    this.sdk.selectNode(ACTIVE_NETWORK.name);
  }
}
