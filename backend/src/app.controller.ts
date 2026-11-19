import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "src/common/decorators/public.decorator";
import { AppService } from "./app.service";

@ApiTags("Health")
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({
    summary: "Health check",
    description: "Returns a simple health check message and server status.",
  })
  @ApiResponse({ status: 200, description: "Server is running." })
  getHello() {
    return this.appService.getHello();
  }
}
