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

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@patternfly/react-core/dist/js/components/Alert";
import { Button } from "@patternfly/react-core/dist/js/components/Button";
import { Form, FormGroup } from "@patternfly/react-core/dist/js/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/js/components/FormSelect";
import { Modal, ModalVariant } from "@patternfly/react-core/dist/js/components/Modal";
import { Spinner } from "@patternfly/react-core/dist/js/components/Spinner";
import { TextInput } from "@patternfly/react-core/dist/js/components/TextInput";
import { ExternalLinkAltIcon } from "@patternfly/react-icons/dist/js/icons/external-link-alt-icon";
import { CorsProxyHeaderKeys } from "@kie-tools/cors-proxy-api/dist";
import { useEnv } from "../env/hooks/EnvContext";
import { useDevDeployments } from "./DevDeploymentsContext";
import { KieSandboxDeployment } from "./services/types";

type JsonSchemaProperty = { type?: string; format?: string; description?: string };
type JsonSchema = { type?: string; properties?: Record<string, JsonSchemaProperty> };

// routeUrl is baked as `${baseUrl}/q/swagger-ui/` (or `${formWebappUrl}/`); trim to recover baseUrl.
function deriveBaseUrl(routeUrl: string): string {
  return routeUrl.replace(/\/(q\/swagger-ui|form-webapp)\/?$/, "").replace(/\/$/, "");
}

function proxiedFetch(targetUrl: string, init: RequestInit, proxyUrl: string | undefined) {
  if (!proxyUrl) {
    return fetch(targetUrl, init);
  }
  const headers = new Headers(init.headers);
  headers.set(CorsProxyHeaderKeys.TARGET_URL, targetUrl);
  return fetch(proxyUrl, { ...init, headers });
}

type State = { kind: "loading" } | { kind: "loaded"; processIds: string[] } | { kind: "error"; message: string };

function ResultLinks(props: {
  body: string;
  deploymentName: string;
  mgmtConsoleUrl: string;
  runtimeProxyBaseUrl: string;
}) {
  // The runtime returns the started instance as JSON with an "id" field.
  // Construct a deep-link to the instance in the Mgmt Console.
  // Mgmt Console URL pattern (Apache Kogito): /<encoded-runtime-url>/process/<instance-id>
  // Only render the link if both URLs are configured via env (KIE_SANDBOX_MGMT_CONSOLE_URL +
  // KIE_SANDBOX_RUNTIME_PROXY_BASE_URL). Otherwise we don't know how the Mgmt Console reaches
  // the runtime and silently omit the link.
  if (!props.mgmtConsoleUrl || !props.runtimeProxyBaseUrl) {
    return null;
  }
  let instanceId: string | undefined;
  try {
    const obj = JSON.parse(props.body);
    if (obj && typeof obj.id === "string") instanceId = obj.id;
  } catch {
    // body wasn't JSON — no link
  }
  if (!instanceId) return null;
  const deployId = props.deploymentName.replace(/^dev-deployment-/, "");
  const runtimeUrl = `${props.runtimeProxyBaseUrl.replace(/\/$/, "")}/${deployId}`;
  const href = `${props.mgmtConsoleUrl.replace(/\/$/, "")}/${encodeURIComponent(runtimeUrl)}/process/${instanceId}`;
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <Button
        component="a"
        href={href}
        target="_blank"
        rel="noreferrer"
        variant="primary"
        icon={<ExternalLinkAltIcon />}
        iconPosition="end"
      >
        View instance in Management Console
      </Button>
    </div>
  );
}

export function DevDeploymentsStartProcessModal() {
  const devDeployments = useDevDeployments();
  const { env } = useEnv();
  const proxyUrl = env.KIE_SANDBOX_CORS_PROXY_URL;

  if (!devDeployments.startProcessModalState.isOpen) {
    return null;
  }
  const { deployment } = devDeployments.startProcessModalState;
  return (
    <Inner
      deployment={deployment}
      proxyUrl={proxyUrl}
      mgmtConsoleUrl={env.KIE_SANDBOX_MGMT_CONSOLE_URL}
      runtimeProxyBaseUrl={env.KIE_SANDBOX_RUNTIME_PROXY_BASE_URL}
    />
  );
}

function Inner(props: {
  deployment: KieSandboxDeployment;
  proxyUrl: string | undefined;
  mgmtConsoleUrl: string;
  runtimeProxyBaseUrl: string;
}) {
  const devDeployments = useDevDeployments();
  const baseUrl = useMemo(() => deriveBaseUrl(props.deployment.routeUrl), [props.deployment.routeUrl]);

  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [schema, setSchema] = useState<JsonSchema | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; body: string } | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Scroll the response into view after a successful (or failed) start, so the
  // user sees the returned instance id without having to scroll manually.
  useEffect(() => {
    if (result) {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [result]);

  const onClose = useCallback(() => {
    devDeployments.setStartProcessModalState({ isOpen: false });
  }, [devDeployments]);

  // Discover available processes once.
  useEffect(() => {
    let cancelled = false;
    proxiedFetch(`${baseUrl}/management/processes`, {}, props.proxyUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((ids: string[]) => {
        if (cancelled) return;
        setState({ kind: "loaded", processIds: ids });
        if (ids.length > 0) setSelectedProcessId(ids[0]);
      })
      .catch((e) => !cancelled && setState({ kind: "error", message: e.message ?? String(e) }));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, props.proxyUrl]);

  // Whenever a process is selected, fetch its input schema and reset form values.
  useEffect(() => {
    if (!selectedProcessId) return;
    let cancelled = false;
    setSchema(null);
    proxiedFetch(`${baseUrl}/${selectedProcessId}/schema`, {}, props.proxyUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: JsonSchema) => {
        if (cancelled) return;
        setSchema(s);
        setFormValues({});
      })
      .catch((e) => !cancelled && setState({ kind: "error", message: e.message ?? String(e) }));
    return () => {
      cancelled = true;
    };
  }, [selectedProcessId, baseUrl, props.proxyUrl]);

  const onSubmit = useCallback(async () => {
    if (!selectedProcessId) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await proxiedFetch(
        `${baseUrl}/${selectedProcessId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formValues),
        },
        props.proxyUrl
      );
      const body = await r.text();
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // body wasn't JSON, leave as-is
      }
      setResult({ ok: r.ok, body: pretty });
    } catch (e: any) {
      setResult({ ok: false, body: e?.message ?? String(e) });
    } finally {
      setSubmitting(false);
    }
  }, [baseUrl, selectedProcessId, formValues, props.proxyUrl]);

  const renderField = (name: string, prop: JsonSchemaProperty) => {
    const id = `start-process-field-${name}`;
    const value = formValues[name];
    if (prop.type === "boolean") {
      return (
        <FormGroup key={name} fieldId={id} label={name}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => setFormValues((v) => ({ ...v, [name]: e.target.checked }))}
          />
        </FormGroup>
      );
    }
    if (prop.type === "integer" || prop.type === "number") {
      return (
        <FormGroup key={name} fieldId={id} label={name}>
          <TextInput
            id={id}
            type="number"
            value={value === undefined ? "" : String(value)}
            onChange={(_e, v) => setFormValues((vs) => ({ ...vs, [name]: v === "" ? "" : Number(v) }))}
          />
        </FormGroup>
      );
    }
    return (
      <FormGroup key={name} fieldId={id} label={name}>
        <TextInput
          id={id}
          type="text"
          value={value === undefined ? "" : String(value)}
          onChange={(_e, v) => setFormValues((vs) => ({ ...vs, [name]: v }))}
        />
      </FormGroup>
    );
  };

  return (
    <Modal
      data-testid="start-process-modal"
      variant={ModalVariant.medium}
      title={`Start a process — ${props.deployment.name}`}
      isOpen={true}
      aria-label="Start process modal"
      onClose={onClose}
      actions={[
        <Button
          key="start"
          variant="primary"
          onClick={onSubmit}
          isDisabled={!schema || submitting || !selectedProcessId}
          isLoading={submitting}
        >
          {submitting ? "Starting…" : "Start"}
        </Button>,
        <Button key="cancel" variant="link" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      {state.kind === "loading" && <Spinner size="md" />}
      {state.kind === "error" && (
        <Alert variant="danger" title="Failed to load processes" isInline>
          {state.message}
        </Alert>
      )}
      {state.kind === "loaded" && state.processIds.length === 0 && (
        <Alert variant="warning" title="No processes available on this deployment" isInline />
      )}
      {state.kind === "loaded" && state.processIds.length > 0 && (
        <Form>
          {state.processIds.length > 1 && (
            <FormGroup fieldId="start-process-id" label="Process">
              <FormSelect
                id="start-process-id"
                value={selectedProcessId}
                onChange={(_e: unknown, v: string) => setSelectedProcessId(v)}
              >
                {state.processIds.map((id) => (
                  <FormSelectOption key={id} value={id} label={id} />
                ))}
              </FormSelect>
            </FormGroup>
          )}
          {schema?.properties && Object.entries(schema.properties).map(([name, prop]) => renderField(name, prop))}
          {!schema && <Spinner size="md" />}
          {result && (
            <div ref={resultRef}>
              <Alert variant={result.ok ? "success" : "danger"} title={result.ok ? "Started" : "Failed"} isInline>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{result.body}</pre>
                {result.ok && (
                  <ResultLinks
                    body={result.body}
                    deploymentName={props.deployment.name}
                    mgmtConsoleUrl={props.mgmtConsoleUrl}
                    runtimeProxyBaseUrl={props.runtimeProxyBaseUrl}
                  />
                )}
              </Alert>
            </div>
          )}
        </Form>
      )}
    </Modal>
  );
}
