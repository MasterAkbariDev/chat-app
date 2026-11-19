import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { ChatFolder } from "./schema/chat-folder.schema";
import { CreateFolderDto } from "./dto/create-folder.dto";
import { UpdateFolderDto } from "./dto/update-folder.dto";

const EMPTY_FILTERS = {
  includeTypes: [],
  includeTags: [],
  includeChannelIds: [],
  excludeChannelIds: [],
  onlyUnread: false,
};

@Injectable()
export class FoldersService {
  constructor(
    @InjectModel(ChatFolder.name)
    private readonly chatFolderModel: Model<ChatFolder>,
  ) {}

  async create(ownerId: string, dto: CreateFolderDto): Promise<ChatFolder> {
    const count = await this.chatFolderModel.countDocuments({ ownerId });
    return this.chatFolderModel.create({
      ownerId,
      name: dto.name,
      order: count,
      filters: { ...EMPTY_FILTERS, ...(dto.filters ?? {}) },
    });
  }

  list(ownerId: string): Promise<ChatFolder[]> {
    return this.chatFolderModel
      .find({ ownerId })
      .sort({ order: 1 })
      .lean()
      .exec();
  }

  async update(
    ownerId: string,
    folderId: string,
    dto: UpdateFolderDto,
  ): Promise<ChatFolder> {
    const existing = await this.chatFolderModel
      .findOne({ _id: folderId, ownerId })
      .exec();
    if (!existing) {
      throw new NotFoundException("Folder not found");
    }
    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.order !== undefined) existing.order = dto.order;
    if (dto.filters !== undefined) {
      existing.filters = { ...existing.filters, ...dto.filters };
    }
    await existing.save();
    return existing;
  }

  async remove(
    ownerId: string,
    folderId: string,
  ): Promise<{ success: boolean }> {
    await this.chatFolderModel.deleteOne({ _id: folderId, ownerId }).exec();
    return { success: true };
  }

  /** Verifies ownership and returns the folder's filters — used by ChannelsService to apply
   *  a folder server-side inside the single `listMine` aggregation. */
  async getOwnedFolder(ownerId: string, folderId: string): Promise<ChatFolder> {
    const folder = await this.chatFolderModel
      .findOne({ _id: folderId, ownerId })
      .lean()
      .exec();
    if (!folder) {
      throw new NotFoundException("Folder not found");
    }
    return folder;
  }
}
