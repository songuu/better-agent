export interface Migration {
  readonly checksum: string;
  readonly downChecksum: string | undefined;
  readonly downSql: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly upSql: string;
  readonly version: number;
}

export interface DownMigrationOptions {
  readonly allowDown: boolean;
}
