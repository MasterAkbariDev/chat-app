import {
  Body,
  Controller,
  Delete,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { AccountDeletionService } from "./account-deletion.service";
import { DeleteAccountDto } from "./dto/delete-account.dto";

@ApiTags("Auth")
@Controller({ path: "auth/account", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AccountController {
  constructor(private accountDeletionService: AccountDeletionService) {}

  @Delete()
  @ApiOperation({
    summary: "Delete your account",
    description:
      "Requires re-entering your current password. Leaves every chat/group/channel, removes " +
      "your blocks, releases your clips/sticker-packs/wallpaper media, anonymises your " +
      "profile (so authored messages show as 'Deleted User'), and logs you out everywhere.",
  })
  @ApiBody({ type: DeleteAccountDto })
  deleteAccount(
    @Req() req: { user: JWTPayload },
    @Body() body: DeleteAccountDto,
  ) {
    return this.accountDeletionService.deleteAccount(
      req.user.userId,
      body.password,
    );
  }
}
