import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { BotMessage } from "./bot-message.schema";

@Injectable()
export class BotMessagesService {
  constructor(
    @InjectModel(BotMessage.name) private readonly messages: Model<BotMessage>,
  ) {}
  async recent(userId: string, botKey: string): Promise<string[]> {
    const rows = await this.messages
      .find({ userId, botKey })
      .sort({ createdAt: -1 })
      .limit(50)
      .select({ text: 1 })
      .lean()
      .exec();
    return rows.reverse().map(row => row.text);
  }
  async append(userId: string, botKey: string, text: string): Promise<void> {
    if (text && text.length <= 2000)
      await this.messages.create({ userId, botKey, text });
  }
}
