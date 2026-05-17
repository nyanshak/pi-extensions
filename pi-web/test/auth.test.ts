import { describe, it, beforeEach, afterEach, expect } from "./test.js";
import { checkAuth, maskPassword } from "../src/auth.js";
import http from "node:http";
import { URL } from "node:url";

// Mock IncomingMessage for testing
function createMockRequest(options: {
  authorization?: string;
  url?: string;
  host?: string;
}): { headers: { authorization?: string; host?: string }; url: string } {
  return {
    headers: {
      authorization: options.authorization,
      host: options.host,
    },
    url: options.url || "/",
  };
}

describe("Auth Module", () => {
  describe("checkAuth", () => {
    it("should accept valid bearer token", () => {
      const req = createMockRequest({
        authorization: "Bearer secret123",
      });

      expect(checkAuth(req as any, "secret123")).toBe(true);
    });

    it("should reject invalid bearer token", () => {
      const req = createMockRequest({
        authorization: "Bearer wrongtoken",
      });

      expect(checkAuth(req as any, "secret123")).toBe(false);
    });

    it("should reject bearer token with wrong password", () => {
      const req = createMockRequest({
        authorization: "Bearer secret123",
      });

      expect(checkAuth(req as any, "differentpass")).toBe(false);
    });

    it("should accept valid password query param", () => {
      const req = createMockRequest({
        url: "/?password=secret123",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(true);
    });

    it("should reject invalid password query param", () => {
      const req = createMockRequest({
        url: "/?password=wrongpass",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(false);
    });

    it("should accept bearer token over query param", () => {
      const req = createMockRequest({
        authorization: "Bearer secret123",
        url: "/?password=wrongpass",
        host: "localhost:8080",
      });

      // Bearer header takes precedence
      expect(checkAuth(req as any, "secret123")).toBe(true);
    });

    it("should accept query param when no bearer header", () => {
      const req = createMockRequest({
        url: "/?password=secret123",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(true);
    });

    it("should handle empty authorization header", () => {
      const req = createMockRequest({
        authorization: "",
        url: "/",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(false);
    });

    it("should handle missing authorization and no query param", () => {
      const req = createMockRequest({
        url: "/",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(false);
    });

    it("should handle password with special characters", () => {
      const req = createMockRequest({
        authorization: "Bearer p@ss!word#123",
      });

      expect(checkAuth(req as any, "p@ss!word#123")).toBe(true);
    });

    it("should handle URL-encoded password in query param", () => {
      const req = createMockRequest({
        url: "/?password=p%40ss%21word",
        host: "localhost:8080",
      });

      // URL decode: p%40ss%21word -> p@ss!word
      expect(checkAuth(req as any, "p@ss!word")).toBe(true);
    });

    it("should handle empty password", () => {
      const req = createMockRequest({
        authorization: "",
        url: "/",
        host: "localhost:8080",
      });

      // Empty authorization header doesn't match empty password pattern
      // (Bearer token format expected, not just empty string)
      expect(checkAuth(req as any, "")).toBe(false);
    });

    it("should reject if bearer is empty string but password not empty", () => {
      const req = createMockRequest({
        authorization: "",
        url: "/",
        host: "localhost:8080",
      });

      expect(checkAuth(req as any, "secret123")).toBe(false);
    });
  });

  describe("maskPassword", () => {
    it("should mask short password", () => {
      expect(maskPassword("abc")).toBe("***");
    });

    it("should mask long password", () => {
      expect(maskPassword("superlongpassword123")).toBe("********************"); // 22 chars
    });

    it("should mask empty password", () => {
      expect(maskPassword("")).toBe("");
    });

    it("should preserve password length in mask", () => {
      const pass = "12345";
      const masked = maskPassword(pass);
      expect(masked.length).toBe(pass.length);
      expect(masked).toBe("*****");
    });
  });
});