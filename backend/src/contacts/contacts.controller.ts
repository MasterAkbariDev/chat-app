import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { ContactsService } from "./contacts.service";
import { AddContactDto } from "./dto/add-contact.dto";

@ApiTags("Contacts (v1)")
@Controller({ path: "contacts", version: "1" })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseFilters(AllExceptionsFilter)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Add a contact by username, exact phone, or exact email",
    description:
      "Exactly one of username/phone/email must be given — no fuzzy matching. Rate-limited.",
  })
  @ApiBody({ type: AddContactDto })
  @ApiResponse({ status: 201, description: "{ _id: string }" })
  addContact(@Body() dto: AddContactDto, @Req() req: { user: JWTPayload }) {
    return this.contactsService.addContact(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List my contacts, with presence + last DM" })
  @ApiResponse({ status: 200, description: "ContactSummaryDto[]" })
  listContacts(@Req() req: { user: JWTPayload }) {
    return this.contactsService.listContacts(req.user.userId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Rename a contact (custom display name)" })
  @ApiBody({
    schema: {
      type: "object",
      properties: { customName: { type: "string", nullable: true } },
    },
  })
  updateContact(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body("customName") customName: string | null,
    @Req() req: { user: JWTPayload },
  ) {
    return this.contactsService.updateContact(
      req.user.userId,
      id,
      customName ?? null,
    );
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a contact" })
  removeContact(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.contactsService.removeContact(req.user.userId, id);
  }
}
