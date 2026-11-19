import { Module } from "@nestjs/common";
import { TokenCacheService } from "./token-cache.service";

/** Leaf module so both AuthModule and UserModule can invalidate the cache without a circular import. */
@Module({
  providers: [TokenCacheService],
  exports: [TokenCacheService],
})
export class TokenCacheModule {}
