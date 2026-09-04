import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { getDb } from "./db";

// Shares the same SQLite file/connection as the app's own data (items,
// projects, stashes) — one database, not two.
export const auth = betterAuth({
  database: getDb(),
  emailAndPassword: {
    enabled: true,
    // No email provider wired up yet — verification would just be a dead
    // end. Revisit once real transactional email exists.
    requireEmailVerification: false,
  },
  plugins: [
    // Doubles as "teams": creating an organization here is what the
    // onboarding flow calls creating a team.
    organization({
      async sendInvitationEmail() {
        // Dummy for now — invitations are created but never emailed or
        // accepted (per product decision), so there's nothing to send yet.
      },
    }),
    nextCookies(), // must stay last
  ],
});

// Same auto-migrate-on-boot approach as lib/db.ts's ensureColumn: create/add
// whatever tables and columns this config needs, idempotently, every boot —
// no separate `auth migrate` CLI step to remember.
void getMigrations(auth.options).then((m) => m.runMigrations());
