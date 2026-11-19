import { ApiProperty, type ApiPropertyOptions } from "@nestjs/swagger";
import { Allow } from "class-validator";
import type { PrivacyAudience } from "../schema/privacy";

type RulePatch =
  | PrivacyAudience
  | { audience?: PrivacyAudience; allow?: string[]; deny?: string[] };

const rule: ApiPropertyOptions = {
  required: false,
  description:
    "An audience (everybody | contacts | nobody), or { audience?, allow?: userId[], deny?: userId[] }",
  oneOf: [
    { type: "string", enum: ["everybody", "contacts", "nobody"] },
    {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["everybody", "contacts", "nobody"] },
        allow: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
      },
    },
  ],
};

/**
 * Send only the settings you want to change. The shape of each value is checked by
 * `PrivacyService.updateSettings` (a union class-validator can't express); `@Allow()` just
 * whitelists the key.
 */
export class UpdatePrivacyDto {
  @ApiProperty(rule) @Allow() phoneNumber?: RulePatch;
  @ApiProperty(rule) @Allow() email?: RulePatch;
  @ApiProperty(rule) @Allow() lastSeen?: RulePatch;
  @ApiProperty(rule) @Allow() profilePhotos?: RulePatch;
  @ApiProperty(rule) @Allow() bio?: RulePatch;
  @ApiProperty(rule) @Allow() calls?: RulePatch;
  @ApiProperty(rule) @Allow() groupInvites?: RulePatch;
  @ApiProperty(rule) @Allow() forwards?: RulePatch;
  @ApiProperty(rule) @Allow() findByUsername?: RulePatch;
  @ApiProperty(rule) @Allow() findByPhoneOrEmail?: RulePatch;
}
