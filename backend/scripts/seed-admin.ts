/**
 * One-off bootstrap: creates (or updates) an admin identity in `admin_users`. There is no
 * public "register admin" endpoint by design (B4, docs/plans/BACKEND_PLAN.md) — this script is
 * the only way to create one, meant to be run once by an operator with direct database access,
 * not exposed over HTTP.
 *
 * Usage:
 *   npm run seed:admin -- --email=admin@example.com --password=... --role=superadmin
 *
 * Prints an otpauth:// URI (and the raw secret as a fallback) for the operator to add to an
 * authenticator app (Google Authenticator, 1Password, etc.) — MFA is required on every admin
 * login, so there is no way to sign in without doing this.
 *
 * Re-running with the same --email updates the password/role and rotates a fresh MFA secret
 * (the old one becomes invalid) — upsert by email, not append-only.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as bcrypt from "bcrypt";
import { authenticator } from "otplib";

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const VALID_ROLES = ["superadmin", "support", "moderator"] as const;

async function main() {
  const { email, password, role = "superadmin" } = parseArgs();
  if (!email || !password) {
    console.error(
      "Usage: npm run seed:admin -- --email=admin@example.com --password=... [--role=superadmin|support|moderator]",
    );
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    console.error(`--role must be one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("Admin passwords must be at least 12 characters.");
    process.exit(1);
  }

  const uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const mfaSecret = authenticator.generateSecret();
    const now = new Date();

    await db.collection("admin_users").updateOne(
      { email: email.toLowerCase().trim() },
      {
        $set: {
          email: email.toLowerCase().trim(),
          passwordHash,
          role,
          mfaSecret,
          isDisabled: false,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    const otpauthUri = authenticator.keyuri(email, "chat-backend", mfaSecret);

    console.log(`\nAdmin identity ready: ${email} (${role})`);
    console.log(`\nScan this otpauth:// URI with an authenticator app:\n  ${otpauthUri}`);
    console.log(`\nOr enter the secret manually:\n  ${mfaSecret}`);
    console.log(
      `\nLog in at POST /v1/admin/auth/login with {email, password, totpCode} once added.\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
