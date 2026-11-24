export function databaseConnectionString(connectionString: string): string {
  const query = connectionString.indexOf("?");
  const fragment = connectionString.indexOf("#");
  if (query < 0 || (fragment >= 0 && fragment < query) || connectionString.startsWith("/")) return connectionString;

  let end = fragment < 0 ? connectionString.length : fragment;
  // The URL parser ignores trailing C0 controls and spaces at the end of the URL.
  if (fragment < 0) {
    while (end > query + 1 && connectionString.charCodeAt(end - 1) <= 0x20) end--;
  }
  // Leave connection-string parsing and duplicate precedence to pg.
  const params = connectionString.slice(query + 1, end)
    .replace(/(^|&)sslmode=require(?=[\t\n\r]*(?:&|$))/g, "$1sslmode=verify-full");
  return connectionString.slice(0, query + 1) + params + connectionString.slice(end);
}
