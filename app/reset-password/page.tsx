import ResetPasswordClient from "./ResetPasswordClient";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  return <ResetPasswordClient token={error ? undefined : token} />;
}
