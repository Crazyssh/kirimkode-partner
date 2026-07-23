/**
 * Portal login page — the redirect target of the protected shell (task 15.1).
 *
 * Unprotected (outside the `(portal)` group). If a valid session already
 * exists, the visitor is sent straight into the dashboard; otherwise the login
 * form is shown. Session resolution is server-side (task 7.2).
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME } from "@application/auth";
import { getAuthorizationServices } from "@application/authorization";

import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Masuk",
};

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const outcome = await getAuthorizationServices().sessionAuthorization.authorize(
    token,
  );
  if (outcome.ok) {
    redirect("/");
  }

  return (
    <div
      data-portal-shell
      className="flex min-h-screen items-center justify-center bg-surface px-6 font-sans text-ink antialiased"
    >
      <main className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand font-mono text-sm font-bold text-[#0C120A]">
            K
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-ink">
              KirimKode
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand">
              Partner
            </p>
          </div>
        </div>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink">
          Masuk ke Portal
        </h1>
        <p className="mt-1 mb-6 text-sm text-ink-muted">
          Kelola perangkat, nomor, order, dan payout Anda.
        </p>
        <LoginForm />
      </main>
    </div>
  );
}
