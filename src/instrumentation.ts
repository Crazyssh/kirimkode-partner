import { initializePartnerProcess } from "@application/bootstrap/partner-process-entry";

export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initializePartnerProcess(process.env);
  }
}
