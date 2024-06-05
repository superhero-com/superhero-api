import { AeSdk, CompilerHttp } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { nodes } from './config';

@Injectable()
export class AeSdkService {
  sdk: AeSdk;
  constructor() {
    console.log('AeSdkService created');

    this.sdk = new AeSdk({
      onCompiler: new CompilerHttp('https://v7.compiler.aepps.com'),
      nodes,
    });
  }
}
