import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AccountMemory } from '@aeternity/aepp-sdk';
import { readFileSync } from 'node:fs';

/** Local operator console. Business rules remain in the running Shorts module. */
@Injectable()
class ShortsOperatorClient {
  async run(command: string, id?: string) {
    if (
      process.env.SHORTS_TESTNET_MVP !== '1' ||
      process.env.NODE_ENV === 'production'
    )
      throw new Error('Local testnet mode required');
    if (
      !['list', 'approve', 'restrict'].includes(command) ||
      (command !== 'list' && !id)
    )
      throw new Error('Use list, approve <short-id>, or restrict <short-id>');
    const key = JSON.parse(
      readFileSync(process.env.SHORTS_OPERATOR_KEY_FILE, 'utf8'),
    );
    const account = new AccountMemory(key.secretKey);
    let token = '';
    const request = async (path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:3334/api/shorts${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shorts-Local': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);
      return result;
    };
    const cfg = await request('/config');
    const deployment = JSON.parse(
      readFileSync(process.env.SHORTS_DEPLOYMENT_FILE, 'utf8'),
    );
    if (
      cfg.network !== 'ae_uat' ||
      cfg.operator !== account.address ||
      cfg.contract !== deployment.contract
    )
      throw new Error('Configured operator/deployment does not match the API');
    const challenge = await request('/auth/challenge', {
      address: account.address,
    });
    token = (
      await request('/auth/verify', {
        id: challenge.id,
        signature: Buffer.from(
          await account.signMessage(challenge.message),
        ).toString('hex'),
      })
    ).token;
    if (command === 'list') {
      const rows = await request('/review');
      console.table(
        rows.map(({ id: shortId, title, moderation, reports }) => ({
          id: shortId,
          title,
          moderation,
          reports,
        })),
      );
    } else
      console.log(
        await request(`/review/${encodeURIComponent(id)}`, {
          approved: command === 'approve',
        }),
      );
  }
}
@Module({ providers: [ShortsOperatorClient] })
class ShortsOperatorModule {}
async function main() {
  const app = await NestFactory.createApplicationContext(ShortsOperatorModule, {
    logger: false,
  });
  try {
    await app.get(ShortsOperatorClient).run(process.argv[2], process.argv[3]);
  } finally {
    await app.close();
  }
}
void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
