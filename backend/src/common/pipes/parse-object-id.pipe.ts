import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from "@nestjs/common";
import { Types } from "mongoose";

/**
 * Validates a route/query param is a well-formed Mongo ObjectId before it reaches a service —
 * turns a malformed id into a clean 400 instead of a raw Mongoose CastError further down
 * (previously an uncaught 500). See docs/plans/BACKEND_PLAN.md B1.
 */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (!Types.ObjectId.isValid(value)) {
      const name = metadata.data ?? "id";
      throw new BadRequestException(`"${name}" must be a valid id`);
    }
    return value;
  }
}
