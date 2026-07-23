export interface MigrationViolation {
  readonly source: string;
  readonly keyword: string;
  readonly line: number;
  readonly column: number;
}

export function scanMigrationSql(
  sql: string,
  source?: string,
): MigrationViolation[];
export function findMigrationSqlFiles(rootDirectory: string): Promise<string[]>;
export function scanMigrationDirectory(rootDirectory: string): Promise<MigrationViolation[]>;
export function assertPartnerCiDatabaseUrl(value: string | undefined): URL;
export function assertPartnerRepository(packageName: string, repositoryRoot: string): void;
