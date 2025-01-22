import { AeSdk, CompilerHttp, MemoryAccount } from '@aeternity/aepp-sdk';
import { nodes } from '../src/ae/config';
import { NETWORK_TESTNET } from '../src/ae/utils/networks';
import { deployCommunityFactory } from "bctsl-sdk";

async function deployContract() {
  const botAccount = {
    publicKey: 'ak_jXYxcXuSvbiJ1GpjYGqiBmGwjHM9i2QbFSNTfsYmP2cYGYj1s',
    secretKey:
      'ce1b873968d868876a42bad32952c6f3f6606f6136f20f623f82665b6c726cd7608fea53a9450d787cbcda0074caf54b80dfc0b395e830057186e287cec8345b',
  };
  const account = new MemoryAccount(botAccount.secretKey);

  const aeSdk = new AeSdk({
    onCompiler: new CompilerHttp('https://v7.compiler.aepps.com'),
    nodes,
    accounts: [account],
  });
  console.log('== activeNetworkName::', NETWORK_TESTNET);
  aeSdk.selectNode(NETWORK_TESTNET.name as any);
  const contract = await deployCommunityFactory(aeSdk);

  console.log('contract', contract);
}

deployContract();
