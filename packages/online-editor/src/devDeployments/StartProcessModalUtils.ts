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

import { CorsProxyHeaderKeys } from "@kie-tools/cors-proxy-api/dist";

/**
 * `KieSandboxDeployment.routeUrl` is set by the service layer to the user-facing
 * landing page for a deployment — `${baseUrl}/q/swagger-ui/` for Quarkus apps,
 * `${formWebappUrl}/` for the DMN form-webapp variant. The modal needs the
 * runtime's API base (no suffix) to call `/management/processes`, schema, and
 * the process POST endpoints, so we recover it by trimming the known suffixes.
 */
export function deriveBaseUrl(routeUrl: string): string {
  return routeUrl.replace(/\/(q\/swagger-ui|form-webapp)\/?$/, "").replace(/\/$/, "");
}

/**
 * `fetch` that routes through Sandbox's cors-proxy when a `proxyUrl` is configured.
 * Uses the existing `target-url` header convention also used by `kubernetes-bridge`.
 */
export function proxiedFetch(targetUrl: string, init: RequestInit, proxyUrl: string | undefined): Promise<Response> {
  if (!proxyUrl) {
    return fetch(targetUrl, init);
  }
  const headers = new Headers(init.headers);
  headers.set(CorsProxyHeaderKeys.TARGET_URL, targetUrl);
  return fetch(proxyUrl, { ...init, headers });
}

/**
 * Build the deep-link URL the Mgmt Console uses to show a single process
 * instance. Pattern: `${mgmtConsole}/${url-encoded runtime URL}/process/${id}`.
 *
 * Returns `undefined` when any of the inputs is missing — the caller can use
 * this as a flag for whether to render the link at all.
 */
export function buildMgmtConsoleInstanceUrl(args: {
  mgmtConsoleUrl: string;
  runtimeProxyBaseUrl: string;
  deploymentName: string;
  instanceId: string;
}): string | undefined {
  if (!args.mgmtConsoleUrl || !args.runtimeProxyBaseUrl || !args.deploymentName || !args.instanceId) {
    return undefined;
  }
  const deployId = args.deploymentName.replace(/^dev-deployment-/, "");
  const runtimeUrl = `${args.runtimeProxyBaseUrl.replace(/\/$/, "")}/${deployId}`;
  const base = args.mgmtConsoleUrl.replace(/\/$/, "");
  return `${base}/${encodeURIComponent(runtimeUrl)}/process/${args.instanceId}`;
}

/**
 * Pull the started instance id out of the runtime's POST response body.
 * Kogito's process-start endpoints reply with JSON `{ id, ...domainFields }`.
 * Returns `undefined` for non-JSON or schema-mismatched bodies.
 */
export function extractInstanceId(responseBody: string): string | undefined {
  try {
    const obj = JSON.parse(responseBody);
    if (obj && typeof obj.id === "string") {
      return obj.id;
    }
  } catch {
    // not JSON — fall through
  }
  return undefined;
}
