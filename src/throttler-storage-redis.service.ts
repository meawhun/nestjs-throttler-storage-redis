import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis, { Cluster, RedisOptions } from 'ioredis';
import { ThrottlerStorageRedis } from './throttler-storage-redis.interface';

@Injectable()
export class ThrottlerStorageRedisService implements ThrottlerStorageRedis, OnModuleDestroy {
  scriptSrc: string;
  redis: Redis | Cluster;
  disconnectRequired?: boolean;
  prefix: string;

  constructor(redis?: Redis, prefix?: string);
  constructor(cluster?: Cluster, prefix?: string);
  constructor(options?: RedisOptions, prefix?: string);
  constructor(url?: string, prefix?: string);
  constructor(redisOrOptions?: Redis | Cluster | RedisOptions | string, prefix?: string) {
    if (redisOrOptions instanceof Redis || redisOrOptions instanceof Cluster) {
      this.redis = redisOrOptions;
    } else if (typeof redisOrOptions === 'string') {
      this.redis = new Redis(redisOrOptions as string);
      this.disconnectRequired = true;
    } else {
      this.redis = new Redis(redisOrOptions as RedisOptions);
      this.disconnectRequired = true;
    }

    this.prefix = prefix || '';
    this.scriptSrc = this.getScriptSrc();
  }

  getScriptSrc(): string {
    // Credits to wyattjoh for the fast implementation you see below.
    // https://github.com/wyattjoh/rate-limit-redis/blob/main/src/lib.ts
    const customPrefix = `${this.prefix}:throttler:`;

    return `
      local key = KEYS[1]
      key = "${customPrefix}" .. key
      local totalHits = redis.call("INCR", key)
      local timeToExpire = redis.call("PTTL", key)
      if timeToExpire <= 0
        then
          redis.call("PEXPIRE", key, tonumber(ARGV[1]))
          timeToExpire = tonumber(ARGV[1])
        end
      return { totalHits, timeToExpire }
    `
      .replace(/^\s+/gm, '')
      .trim();
  }

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    // Use EVAL instead of EVALSHA to support both redis instances and clusters.
    const results: number[] = (await this.redis.call(
      'EVAL',
      this.scriptSrc,
      1,
      key,
      ttl,
    )) as number[];

    if (!Array.isArray(results)) {
      throw new TypeError(`Expected result to be array of values, got ${results}`);
    }

    if (results.length !== 2) {
      throw new Error(`Expected 2 values, got ${results.length}`);
    }

    const [totalHits, timeToExpire] = results;

    if (typeof totalHits !== 'number') {
      throw new TypeError('Expected totalHits to be a number');
    }

    if (typeof timeToExpire !== 'number') {
      throw new TypeError('Expected timeToExpire to be a number');
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpire / 1000),
    };
  }

  onModuleDestroy() {
    if (this.disconnectRequired) {
      this.redis?.disconnect(false);
    }
  }
}
