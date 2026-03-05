import { AeSdk, CompilerHttp, Contract } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { ACTIVE_NETWORK, nodes } from '../configs';

type LegacyAeSdk = AeSdk & {
  initializeContract?: (
    options: Parameters<typeof Contract.initialize>[0],
  ) => ReturnType<typeof Contract.initialize>;
};

@Injectable()
export class AeSdkService {
  sdk: AeSdk;
  constructor() {
    this.sdk = new AeSdk({
      onCompiler: new CompilerHttp('https://v7.compiler.aepps.com'),
      nodes,
      // gasLimit: 5818000,
    });

    this.sdk.selectNode(ACTIVE_NETWORK.name);

    // Backward compatibility for libraries still calling AeSdk.initializeContract (removed in aepp-sdk v14).
    const sdkWithLegacyApi = this.sdk as LegacyAeSdk;
    sdkWithLegacyApi.initializeContract = (options) =>
      Contract.initialize({
        ...this.sdk.getContext(),
        ...options,
      });
  }
}
