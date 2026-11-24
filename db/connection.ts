export function databaseConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Let pg interpret socket paths and URLs with an omitted host.
    return connectionString;
  }
  if (
    url.searchParams.getAll("uselibpqcompat").at(-1) === "true" ||
    url.searchParams.getAll("sslmode").at(-1) !== "require"
  ) return connectionString;

  // Preserve pg's current default certificate checks when using a Neon URL.
  url.searchParams.set("sslmode", "verify-full");
  return url.href;
}
