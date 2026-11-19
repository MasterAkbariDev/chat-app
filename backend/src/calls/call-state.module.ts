import { Module } from "@nestjs/common";
import { CallStateService } from "./call-state.service";

/** Call state on its own, so the chat list (`ChannelsModule`) can read "is a voice chat live
 *  here" without depending on the whole calls module (gateway, messages, LiveKit). */
@Module({
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
