import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ChatFolder, ChatFolderSchema } from "./schema/chat-folder.schema";
import { FoldersController } from "./folders.controller";
import { FoldersService } from "./folders.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatFolder.name, schema: ChatFolderSchema },
    ]),
  ],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
