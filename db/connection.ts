export function databaseConnectionString(connectionString: string): string {
  const query = connectionString.indexOf("?");
  const fragment = connectionString.indexOf("#");
  if (query < 0 || (fragment >= 0 && fragment < query) || connectionString.startsWith("/")) return connectionString;

  let end = fragment < 0 ? connectionString.length : fragment;
  // The URL parser ignores trailing C0 controls and spaces at the end of the URL.
  if (fragment < 0) {
    while (end > query + 1 && connectionString.charCodeAt(end - 1) <= 0x20) end--;
  }
  const fields = connectionString.slice(query + 1, end).split("&");
  for (let i = fields.length - 1; i >= 0; i--) {
    const mode = new URLSearchParams("&" + fields[i].replace(/[\t\n\r]/g, "")).get("sslmode");
    if (mode === null) continue;
    if (mode !== "require") return connectionString;
    // pg uses the last value. Keep the original spelling of the other options for pg.
    fields[i] = "sslmode=verify-full";
    return connectionString.slice(0, query + 1) + fields.join("&") + connectionString.slice(end);
  }
  return connectionString;
}
