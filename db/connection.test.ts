import { expect, test } from "bun:test";
import { databaseConnectionString } from "./connection";

test("keeps certificate and hostname verification for require in libpq mode", () => {
  const url = "postgresql://db.example/test?sslmode=require&uselibpqcompat=true";
  expect(new URL(databaseConnectionString(url)).searchParams.get("sslmode")).toBe("verify-full");
});

test("preserves explicit CA verification without hostname verification", () => {
  const url = "postgresql://db.example/test?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=%2Fca.pem";
  expect(databaseConnectionString(url)).toBe(url);
});

test("keeps certificate verification when pg gets the host from the query", () => {
  const url = "postgresql://user@/test?host=db.example&sslmode=require&uselibpqcompat=true";
  expect(databaseConnectionString(url)).toBe(url.replace("sslmode=require", "sslmode=verify-full"));
});

test("keeps certificate verification for default pg URLs without changing credentials", () => {
  const url = "postgresql://user:sslmode=require@db.example/test?sslmode=require";
  const normalized = new URL(databaseConnectionString(url));
  expect(decodeURIComponent(normalized.password)).toBe("sslmode=require");
  expect(normalized.searchParams.get("sslmode")).toBe("verify-full");
});

test("uses the effective query option when the connection string repeats a parameter", () => {
  const url = "postgresql://db.example/test?sslmode=require&sslmode=disable";
  expect(databaseConnectionString(url)).toBe(url);
});
