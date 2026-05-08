/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  buildMgmtConsoleInstanceUrl,
  extractInstanceId,
  proxiedFetch,
} from "../../src/devDeployments/StartProcessModalUtils";

describe("extractInstanceId", () => {
  test("returns the id from a typical Kogito start-instance response", () => {
    const body = JSON.stringify({ id: "abc-123", offer: null, bonus: 150 });
    expect(extractInstanceId(body)).toBe("abc-123");
  });

  test("returns undefined when the body is not JSON", () => {
    expect(extractInstanceId("<html>not json</html>")).toBeUndefined();
  });

  test("returns undefined when the body has no id field", () => {
    expect(extractInstanceId(JSON.stringify({ offer: "foo" }))).toBeUndefined();
  });

  test("returns undefined when id is non-string", () => {
    expect(extractInstanceId(JSON.stringify({ id: 42 }))).toBeUndefined();
  });
});

describe("buildMgmtConsoleInstanceUrl", () => {
  const base = {
    mgmtConsoleUrl: "http://localhost:8281",
    runtimeProxyBaseUrl: "http://localhost:8090/cluster",
    deploymentName: "dev-deployment-abc123",
    instanceId: "00000000-0000-0000-0000-000000000001",
  };

  test("encodes the runtime URL into the path", () => {
    const url = buildMgmtConsoleInstanceUrl(base);
    expect(url).toBe(
      "http://localhost:8281/" +
        encodeURIComponent("http://localhost:8090/cluster/abc123") +
        "/process/00000000-0000-0000-0000-000000000001"
    );
  });

  test("strips the dev-deployment- prefix from deploymentName when building the runtime URL", () => {
    const url = buildMgmtConsoleInstanceUrl(base)!;
    expect(url).toContain(encodeURIComponent("/cluster/abc123"));
    expect(url).not.toContain("dev-deployment-");
  });

  test("trims trailing slashes in input URLs to avoid double slashes", () => {
    const url = buildMgmtConsoleInstanceUrl({
      ...base,
      mgmtConsoleUrl: "http://localhost:8281/",
      runtimeProxyBaseUrl: "http://localhost:8090/cluster/",
    });
    expect(url).not.toMatch(/\/\/process\//);
    expect(url).toMatch(/^http:\/\/localhost:8281\/[^/]/);
  });

  test("returns undefined when any required input is empty", () => {
    expect(buildMgmtConsoleInstanceUrl({ ...base, mgmtConsoleUrl: "" })).toBeUndefined();
    expect(buildMgmtConsoleInstanceUrl({ ...base, runtimeProxyBaseUrl: "" })).toBeUndefined();
    expect(buildMgmtConsoleInstanceUrl({ ...base, deploymentName: "" })).toBeUndefined();
    expect(buildMgmtConsoleInstanceUrl({ ...base, instanceId: "" })).toBeUndefined();
  });
});

describe("proxiedFetch", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("ok") });
    (globalThis as any).fetch = mockFetch;
  });

  test("calls the target URL directly when no proxyUrl is provided", async () => {
    await proxiedFetch("http://example.com/q/health", {}, undefined);
    expect(mockFetch).toHaveBeenCalledWith("http://example.com/q/health", {});
  });

  test("routes through the proxy with a target-url header when proxyUrl is set", async () => {
    await proxiedFetch("http://example.com/q/health", { method: "GET" }, "http://localhost:8080");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("http://localhost:8080");
    const headers = calledInit.headers as Headers;
    expect(headers.get("target-url")).toBe("http://example.com/q/health");
    expect(calledInit.method).toBe("GET");
  });

  test("preserves caller-supplied init headers and merges with target-url", async () => {
    await proxiedFetch(
      "http://example.com/q/health",
      { headers: { "Content-Type": "application/json", "X-Custom": "yes" } },
      "http://localhost:8080"
    );
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("yes");
    expect(headers.get("target-url")).toBe("http://example.com/q/health");
  });
});
