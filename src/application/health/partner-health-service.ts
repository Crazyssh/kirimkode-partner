export const DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE" as const;

export interface HealthSnapshot {
  status: "live" | "ready" | typeof DEPENDENCY_UNAVAILABLE;
  version: string;
  time: string;
}

export interface ReadinessProbe {
  isReady(): Promise<boolean>;
}

export type Clock = () => Date;

export class PartnerHealthService {
  constructor(
    private readonly version: string,
    private readonly readinessProbe: ReadinessProbe,
    private readonly clock: Clock = () => new Date(),
  ) {}

  liveness(): HealthSnapshot {
    return this.snapshot("live");
  }

  async readiness(): Promise<HealthSnapshot> {
    try {
      return this.snapshot((await this.readinessProbe.isReady()) ? "ready" : DEPENDENCY_UNAVAILABLE);
    } catch {
      return this.snapshot(DEPENDENCY_UNAVAILABLE);
    }
  }

  private snapshot(status: HealthSnapshot["status"]): HealthSnapshot {
    return { status, version: this.version, time: this.clock().toISOString() };
  }
}
