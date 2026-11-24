import { expect, test } from "bun:test";
import { databaseConnectionString } from "./connection";

test("preserves explicit libpq TLS modes", () => {
  const url = "postgresql://db.example/test?sslmode=require&uselibpqcompat=true";
  expect(databaseConnectionString(url)).toBe(url);
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
