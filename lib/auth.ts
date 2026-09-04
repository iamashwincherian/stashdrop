import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization, emailOTP } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { getDb, seedDemoWorkspace } from "./db";
import { sendMail } from "./mailer";

// Shares the same SQLite file/connection as the app's own data (items,
// projects, stashes) — one database, not two.
export const auth = betterAuth({
  database: getDb(),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    // Re-sends a fresh code on a blocked sign-in attempt instead of just
    // rejecting it — the user always has a live code to enter, on sign-up
    // or any later sign-in, until they verify.
    sendOnSignIn: true,
    // Without this, verifyEmailOTP only flips emailVerified and returns —
    // it doesn't create a session. Sign-up never signs the user in while
    // unverified, so without auto-sign-in there'd be no way to reach a
    // session at all after entering the right code.
    autoSignInAfterVerification: true,
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      // Redirects the normal "click a link" verification email through the
      // OTP sender below instead — sign-up/sign-in both end up here.
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "email-verification") return;
        await sendMail({
          to: email,
          subject: "Your Stashdrop verification code",
          html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:600;letter-spacing:.1em">${otp}</p><p>It expires in 10 minutes.</p>`,
        });
      },
    }),
    // Doubles as "teams": creating an organization here is what the
    // onboarding flow calls creating a team.
    organization({
      async sendInvitationEmail(data) {
        const url = `${process.env.BETTER_AUTH_URL}/accept-invite?id=${data.id}`;
        await sendMail({
          to: data.email,
          subject: `You've been invited to join ${data.organization.name} on Stashdrop`,
          html: `<p>${data.inviter.user.name} invited you to join <strong>${data.organization.name}</strong> on Stashdrop.</p><p><a href="${url}">Accept the invitation</a></p>`,
        });
      },
    }),
    nextCookies(), // must stay last
  ],
});

// Same auto-migrate-on-boot approach as lib/db.ts's ensureColumn: create/add
// whatever tables and columns this config needs, idempotently, every boot —
// no separate `auth migrate` CLI step to remember. The demo workspace seed
// needs better-auth's own `user`/`account` tables, so it only runs after
// these migrations land.
void getMigrations(auth.options).then((m) => m.runMigrations()).then(() => seedDemoWorkspace()).catch((e) => console.error("seedDemoWorkspace failed", e));
