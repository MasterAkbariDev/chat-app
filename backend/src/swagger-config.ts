import { DocumentBuilder } from "@nestjs/swagger";

/**
 * Single source of truth for the OpenAPI document metadata — shared by the live `/docs` UI
 * (main.ts) and the CI export script (scripts/export-openapi.ts) so they can never drift.
 */
export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle("Chat API")
    .setDescription(
      "Backend API for Chat: auth, users, chats, messages. Real-time via WebSocket at /. " +
        "Use a Bearer token from login/register for protected routes. " +
        "See REALTIME.md for the WebSocket event contract (not representable in OpenAPI).",
    )
    .setVersion("1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT", in: "header" },
      "access-token",
    )
    .build();
}
