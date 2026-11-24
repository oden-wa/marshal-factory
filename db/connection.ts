export function databaseConnectionString(connectionString: string): string {
  const query = connectionString.indexOf("?");
  const fragment = connectionString.indexOf("#");
  if (query < 0 || (fragment >= 0 && fragment < query) || connectionString.startsWith("/")) return connectionString;

  // Parse only the query so pg can still handle connection URLs with an omitted host.
  const end = fragment < 0 ? connectionString.length : fragment;
  const params = new URLSearchParams(connectionString.slice(query + 1, end).replace(/[\t\n\r]/g, ""));
  if (params.getAll("sslmode").at(-1) !== "require") return connectionString;
  // Keep the pool's certificate and hostname checks, including with libpq compatibility.
  params.set("sslmode", "verify-full");
  return connectionString.slice(0, query + 1) + params.toString() + connectionString.slice(end);
}
