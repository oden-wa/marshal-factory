// The slice of bun:sqlite that the runner uses. @types/bun would also retype global fetch,
// which lib/linear.ts relies on, so this declares only the module.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    exec(sql: string): void;
    query<Row = unknown>(sql: string): {
      all(...params: unknown[]): Row[];
      get(...params: unknown[]): Row | null;
      run(...params: unknown[]): void;
    };
    transaction<Result>(fn: () => Result): { immediate(): Result; exclusive(): Result };
    close(): void;
  }
}
