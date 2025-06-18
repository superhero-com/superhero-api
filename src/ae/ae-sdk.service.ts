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
      gasLimit: 5818000,
    });

    this.sdk.selectNode(ACTIVE_NETWORK.name);
  }
}
