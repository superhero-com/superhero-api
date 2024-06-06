import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import 'dotenv/config';

export const DATABASE_CONFIG: TypeOrmModuleOptions = {
  type: process.env.DB_TYPE as any,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: process.env.DB_SYNC === 'true' ? true : false,
};
