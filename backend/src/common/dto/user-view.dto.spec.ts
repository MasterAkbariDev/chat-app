import { toMeDto, toPublicUserDto } from "./user-view.dto";

/**
 * The literal acceptance criterion for B1: "every user-returning endpoint emits PublicUserDto"
 * and never leaks password/tokenVersion. This test feeds the mappers a full, hostile input
 * (as if someone forgot to project a query) and asserts the forbidden keys never survive.
 */
describe("user-view DTO mappers (B1 leak test)", () => {
  const hostileUser = {
    _id: "507f1f77bcf86cd799439011",
    username: "alice",
    firstName: "Alice",
    lastName: "Doe",
    image: ["https://example.com/a.jpg"],
    bio: "hi",
    email: "alice@example.com",
    phoneNumber: "+10000000000",
    password: "$2b$10$hashedhashedhashedhashedhashed",
    tokenVersion: 3,
    isDeleted: false,
    isOnline: true,
    bigEmojis: true,
    quickReaction: "👍",
    lastSeen: new Date("2024-01-01"),
  };

  it("toPublicUserDto never includes password/tokenVersion/email/phoneNumber/isDeleted", () => {
    const dto = toPublicUserDto(hostileUser);
    expect(dto).not.toHaveProperty("password");
    expect(dto).not.toHaveProperty("tokenVersion");
    expect(dto).not.toHaveProperty("email");
    expect(dto).not.toHaveProperty("phoneNumber");
    expect(dto).not.toHaveProperty("isDeleted");
    expect(dto).not.toHaveProperty("isOnline");
    expect(dto).toEqual({
      _id: hostileUser._id,
      username: "alice",
      firstName: "Alice",
      lastName: "Doe",
      avatarUrl: hostileUser.image,
      bio: "hi",
    });
  });

  it("toMeDto (self view) never includes password/tokenVersion/isDeleted", () => {
    const dto = toMeDto(hostileUser);
    expect(dto).not.toHaveProperty("password");
    expect(dto).not.toHaveProperty("tokenVersion");
    expect(dto).not.toHaveProperty("isDeleted");
    // Self is allowed to see these — unlike PublicUserDto.
    expect(dto.email).toBe("alice@example.com");
    expect(dto.phoneNumber).toBe("+10000000000");
  });
});
