import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PacksController } from "./packs.controller";
import { PacksService } from "./packs.service";
import { Pack, PackSchema } from "./schema/pack.schema";
import { PackItem, PackItemSchema } from "./schema/pack-item.schema";
import {
  PackSubscription,
  PackSubscriptionSchema,
} from "./schema/pack-subscription.schema";
import { MediaModule } from "src/media/media.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Pack.name, schema: PackSchema },
      { name: PackItem.name, schema: PackItemSchema },
      { name: PackSubscription.name, schema: PackSubscriptionSchema },
    ]),
    MediaModule,
  ],
  controllers: [PacksController],
  providers: [PacksService],
  exports: [PacksService],
})
export class PacksModule {}
