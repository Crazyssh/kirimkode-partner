import type { Metadata } from "next";

import { AdminLoginForm } from "./_components/admin-login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Masuk Admin",
};

/**
 * Partner Admin login page (task 15.3). Standalone and unauthenticated — it is
 * the redirect target of {@link requireAdminSession}. Authenticating here sets
 * the dedicated admin session cookie via the admin session API, entirely
 * separate from the tenant portal login (requirement 16.1).
 */
export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
          KirimKode Admin
        </p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Masuk area admin</h1>
        <p className="mt-2 text-sm text-slate-500">
          Area administrasi Partner Platform. Terpisah dari portal partner.
        </p>
      </div>
      <AdminLoginForm />
    </main>
  );
}
