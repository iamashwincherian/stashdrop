import { createAuthClient } from "better-auth/react";
import { organizationClient, emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient(), emailOTPClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
