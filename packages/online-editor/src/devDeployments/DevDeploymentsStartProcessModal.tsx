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
import { Checkbox } from "@patternfly/react-core/dist/js/components/Checkbox";
import { CodeBlock, CodeBlockCode } from "@patternfly/react-core/dist/js/components/CodeBlock";
import { Form, FormGroup } from "@patternfly/react-core/dist/js/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/js/components/FormSelect";
import { Modal, ModalVariant } from "@patternfly/react-core/dist/js/components/Modal";
import { Spinner } from "@patternfly/react-core/dist/js/components/Spinner";
import { TextInput } from "@patternfly/react-core/dist/js/components/TextInput";
import { ExternalLinkAltIcon } from "@patternfly/react-icons/dist/js/icons/external-link-alt-icon";
import { useEnv } from "../env/hooks/EnvContext";
import { useOnlineI18n } from "../i18n";
import { useDevDeployments } from "./DevDeploymentsContext";
import { KieSandboxDeployment } from "./services/types";
import { buildMgmtConsoleInstanceUrl, extractInstanceId, proxiedFetch } from "./StartProcessModalUtils";

type JsonSchemaProperty = { type?: string; format?: string; description?: string };
type JsonSchema = { type?: string; properties?: Record<string, JsonSchemaProperty>; required?: string[] };

type State = { kind: "loading" } | { kind: "loaded"; processIds: string[] } | { kind: "error"; message: string };

function ResultLinks(props: {
  body: string;
  deploymentName: string;
  mgmtConsoleUrl: string;
  runtimeProxyBaseUrl: string;
  label: string;
}) {
  const instanceId = extractInstanceId(props.body);
  if (!instanceId) return null;
  const href = buildMgmtConsoleInstanceUrl({
    mgmtConsoleUrl: props.mgmtConsoleUrl,
    runtimeProxyBaseUrl: props.runtimeProxyBaseUrl,
    deploymentName: props.deploymentName,
    instanceId,
  });
  if (!href) return null;
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
        {props.label}
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
  const { i18n } = useOnlineI18n();
  const t = i18n.devDeployments.startProcessModal;
  const baseUrl = props.deployment.baseUrl;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");
  const [schema, setSchema] = useState<JsonSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; body: string } | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  // Used by `onSubmit` to bail out of post-await setState calls if the modal
  // was closed mid-flight (otherwise React 18 strict-mode warns/throws).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
    setSchemaError(null);
    proxiedFetch(`${baseUrl}/${selectedProcessId}/schema`, {}, props.proxyUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: JsonSchema) => {
        if (cancelled) return;
        setSchema(s);
        // Pre-seed booleans to `false` so a `required: [...]` entry naming a
        // boolean field doesn't keep the Start button disabled until the user
        // clicks the checkbox (which would only ever set it to `true` anyway).
        const initial: Record<string, boolean> = {};
        for (const [name, prop] of Object.entries(s.properties ?? {})) {
          if (prop.type === "boolean") initial[name] = false;
        }
        setFormValues(initial);
      })
      .catch((e) => !cancelled && setSchemaError(e.message ?? String(e)));
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
      if (!isMountedRef.current) return;
      setResult({ ok: r.ok, body: pretty });
    } catch (e: any) {
      if (!isMountedRef.current) return;
      setResult({ ok: false, body: e?.message ?? String(e) });
    } finally {
      if (isMountedRef.current) setSubmitting(false);
    }
  }, [baseUrl, selectedProcessId, formValues, props.proxyUrl]);

  const requiredFields = useMemo(() => new Set(schema?.required ?? []), [schema]);

  const missingRequired = useMemo(() => {
    for (const name of requiredFields) {
      const v = formValues[name];
      if (v === undefined || v === "") return true;
    }
    return false;
  }, [requiredFields, formValues]);

  const renderField = (name: string, prop: JsonSchemaProperty) => {
    const id = `start-process-field-${name}`;
    const value = formValues[name];
    const isRequired = requiredFields.has(name);
    if (prop.type === "boolean") {
      // Booleans are pre-seeded to `false` on schema load (see useEffect), so
      // a `required: [...]` entry pointing at a boolean is structurally moot
      // — the field always carries a value.
      return (
        <FormGroup key={name} fieldId={id}>
          <Checkbox
            id={id}
            label={name}
            isChecked={value === true}
            onChange={(_e, checked) => setFormValues((v) => ({ ...v, [name]: checked }))}
          />
        </FormGroup>
      );
    }
    if (prop.type === "integer" || prop.type === "number") {
      return (
        <FormGroup key={name} fieldId={id} label={name} isRequired={isRequired}>
          <TextInput
            id={id}
            type="number"
            isRequired={isRequired}
            value={value === undefined ? "" : String(value)}
            onChange={(_e, v) => setFormValues((vs) => ({ ...vs, [name]: v === "" ? "" : Number(v) }))}
          />
        </FormGroup>
      );
    }
    if (prop.type === "object" || prop.type === "array") {
      // Complex shapes need a JSON editor / nested form, which the modal
      // doesn't render. Surface the limitation rather than coercing the
      // value into a string the runtime won't accept.
      return (
        <FormGroup key={name} fieldId={id} label={name}>
          <Alert variant="info" isInline isPlain title={t.unsupportedFieldType(prop.type)} />
        </FormGroup>
      );
    }
    return (
      <FormGroup key={name} fieldId={id} label={name} isRequired={isRequired}>
        <TextInput
          id={id}
          type="text"
          isRequired={isRequired}
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
      title={t.title(props.deployment.name)}
      isOpen={true}
      aria-label={t.title(props.deployment.name)}
      onClose={onClose}
      actions={[
        <Button
          key="start"
          variant="primary"
          onClick={onSubmit}
          isDisabled={!schema || !!schemaError || submitting || !selectedProcessId || missingRequired}
          isLoading={submitting}
        >
          {submitting ? t.startingButton : t.startButton}
        </Button>,
        <Button key="cancel" variant="link" onClick={onClose}>
          {t.closeButton}
        </Button>,
      ]}
    >
      {state.kind === "loading" && <Spinner size="md" />}
      {state.kind === "error" && (
        <Alert variant="danger" title={t.loadProcessesError} isInline>
          {state.message}
        </Alert>
      )}
      {state.kind === "loaded" && state.processIds.length === 0 && (
        <Alert variant="warning" title={t.noProcesses} isInline />
      )}
      {state.kind === "loaded" && state.processIds.length > 0 && (
        <Form>
          {state.processIds.length > 1 && (
            <FormGroup fieldId="start-process-id" label={t.processFieldLabel}>
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
          {schemaError && (
            <Alert variant="danger" title={t.loadSchemaError} isInline>
              {schemaError}
            </Alert>
          )}
          {schema?.properties && Object.entries(schema.properties).map(([name, prop]) => renderField(name, prop))}
          {!schema && !schemaError && <Spinner size="md" />}
          {result && (
            <div ref={resultRef}>
              <Alert
                variant={result.ok ? "success" : "danger"}
                title={result.ok ? t.startedTitle : t.failedTitle}
                isInline
              >
                <CodeBlock>
                  <CodeBlockCode>{result.body}</CodeBlockCode>
                </CodeBlock>
                {result.ok && (
                  <ResultLinks
                    body={result.body}
                    deploymentName={props.deployment.name}
                    mgmtConsoleUrl={props.mgmtConsoleUrl}
                    runtimeProxyBaseUrl={props.runtimeProxyBaseUrl}
                    label={t.viewInMgmtConsole}
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
