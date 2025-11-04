import { Injectable } from '@nestjs/common';
import S3 from 'aws-sdk/clients/s3';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class GraffitiStorageService {
  private client: S3;
  private localBackupDir: string;

  constructor() {
    this.client = new S3({
      accessKeyId: process.env.S3_KEY,
      secretAccessKey: process.env.S3_SECRET,
      region: process.env.S3_REGION,
    });
    this.localBackupDir = path.join(process.cwd(), 'data', 'graffiti-backup');
    if (!fs.existsSync(this.localBackupDir))
      fs.mkdirSync(this.localBackupDir, { recursive: true });
  }

  async backupSvg(ipfsHash: string, buffer: Buffer) {
    fs.writeFileSync(path.join(this.localBackupDir, `${ipfsHash}.svg`), buffer);
    if (!process.env.S3_BUCKET) return;
    await this.client
      .putObject({
        Body: buffer,
        Bucket: process.env.S3_BUCKET,
        Key: `${ipfsHash}.svg`,
      })
      .promise();
  }

  async retrieveSvg(ipfsHash: string): Promise<Buffer> {
    if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET not configured');
    const res = await this.client
      .getObject({ Bucket: process.env.S3_BUCKET, Key: `${ipfsHash}.svg` })
      .promise();
    return res.Body as Buffer;
  }

  async tryReadLocal(ipfsHash: string): Promise<Buffer> {
    const p = path.join(this.localBackupDir, `${ipfsHash}.svg`);
    if (!fs.existsSync(p)) throw new Error('not found');
    return fs.readFileSync(p);
  }
}
