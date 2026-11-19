import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { CallsService } from "./calls.service";

@ApiTags("Calls (v1)")
@Controller({ path: "calls", version: "1" })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseFilters(AllExceptionsFilter)
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get("incoming")
  @ApiOperation({
    summary: "Calls ringing me right now",
    description:
      "DM calls currently ringing the signed-in user — for a client that (re)connected or " +
      "was opened from a call notification after the ring went out.",
  })
  @ApiResponse({
    status: 200,
    description:
      "{ calls: [{ callId, channelId, fromUserId, fromUsername, isPrivate, expiresAt }] }",
  })
  async incoming(@Req() req: { user: JWTPayload }) {
    return {
      calls: await this.callsService.pendingIncomingCalls(req.user.userId),
    };
  }

  @Get("channel/:channelId")
  @ApiOperation({
    summary: "The live voice chat in a group/channel",
    description: "Members only. `call` is null when no voice chat is running.",
  })
  @ApiParam({ name: "channelId" })
  @ApiResponse({
    status: 200,
    description:
      "{ call: { callId, channelId, startedAt, participants: [{ _id, name, photo }] } | null }",
  })
  async channelCall(
    @Param("channelId") channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return {
      call: await this.callsService.activeGroupCall(channelId, req.user.userId),
    };
  }

  @Post()
  @ApiOperation({
    summary: "Start a call in a channel",
    description:
      "Private chat: rings the other member (socket + push), gives up after 45 s as a missed " +
      "call. Group/channel: starts the chat's voice chat — or joins it if one is already " +
      'running — without ringing anyone (posts "X started a voice chat"). Returns a LiveKit ' +
      "room token for the caller.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
    },
  })
  @ApiResponse({
    status: 201,
    description: "{ callId, roomName, roomToken, livekitUrl }",
  })
  create(
    @Body("channelId") channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.callsService.createCall(channelId, req.user.userId);
  }

  @Post(":callId/join")
  @ApiOperation({
    summary: "Answer a ringing call, or join a running group voice chat",
  })
  @ApiParam({ name: "callId" })
  @ApiResponse({
    status: 201,
    description: "{ callId, roomName, roomToken, livekitUrl }",
  })
  join(@Param("callId") callId: string, @Req() req: { user: JWTPayload }) {
    return this.callsService.joinCall(callId, req.user.userId);
  }

  @Post(":callId/leave")
  @ApiOperation({
    summary: "Leave a call",
    description:
      "A private call always ends the moment either side leaves; a group call ends once " +
      "everyone has left.",
  })
  @ApiParam({ name: "callId" })
  @ApiResponse({ status: 201, description: "{ success: true }" })
  leave(@Param("callId") callId: string, @Req() req: { user: JWTPayload }) {
    return this.callsService.leaveCall(callId, req.user.userId);
  }

  @Post(":callId/decline")
  @ApiOperation({
    summary: "Decline a ringing private call",
    description: "Private calls only — before ever joining.",
  })
  @ApiParam({ name: "callId" })
  @ApiResponse({ status: 201, description: "{ success: true }" })
  decline(@Param("callId") callId: string, @Req() req: { user: JWTPayload }) {
    return this.callsService.declineCall(callId, req.user.userId);
  }
}
