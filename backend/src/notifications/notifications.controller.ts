import {
  Body,
  Controller,
  Delete,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { NotificationService } from "./notification.service";

@ApiTags("Push notifications (v1)")
@Controller({ path: "push/tokens", version: "1" })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseFilters(AllExceptionsFilter)
export class NotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post()
  @ApiOperation({
    summary: "Register this device's FCM token",
    description:
      "Android/Flutter only. Call again on token refresh — it's an upsert keyed on the token itself.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { token: { type: "string" }, ua: { type: "string" } },
      required: ["token"],
    },
  })
  @ApiResponse({ status: 201, description: "{ success: true }" })
  register(
    @Body("token") token: string,
    @Body("ua") ua: string | undefined,
    @Req() req: { user: JWTPayload },
  ) {
    return this.notificationService.registerToken(req.user.userId, token, ua);
  }

  @Delete()
  @ApiOperation({
    summary: "Unregister this device's FCM token",
    description: "Call on logout so a signed-out device stops receiving push.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
    },
  })
  @ApiResponse({ status: 200, description: "{ success: true }" })
  unregister(@Body("token") token: string, @Req() req: { user: JWTPayload }) {
    return this.notificationService.removeToken(req.user.userId, token);
  }
}
