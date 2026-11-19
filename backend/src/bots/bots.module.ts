import { Module } from "@nestjs/common";
import { BotsController } from "./bots.controller";
import { BotsRegistry } from "./bots.registry";
import { BOT_HANDLERS } from "./bot.interface";
import { PackManagerBot } from "./handlers/pack-manager.bot";
import { PacksModule } from "src/packs/packs.module";
import { BotAccessService } from "./bot-access.service";
import { MongooseModule } from "@nestjs/mongoose";
import { BotMessage, BotMessageSchema } from "./bot-message.schema";
import { BotMessagesService } from "./bot-messages.service";
import { ExternalBotEventsController } from "./external-bot-events.controller";

/**
 * Built-in pack management is registered here. Independent bots use the external
 * protocol and deployment configuration without adding providers to this module.
 */
@Module({
  imports: [
    PacksModule,
    MongooseModule.forFeature([
      { name: BotMessage.name, schema: BotMessageSchema },
    ]),
  ],
  controllers: [BotsController, ExternalBotEventsController],
  providers: [
    BotsRegistry,
    BotAccessService,
    BotMessagesService,
    PackManagerBot,
    {
      provide: BOT_HANDLERS,
      useFactory: (packManagerBot: PackManagerBot) => [packManagerBot],
      inject: [PackManagerBot],
    },
  ],
})
export class BotsModule {}
