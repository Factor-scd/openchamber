import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n";
import { useUIStore } from "@/stores/useUIStore";

import { HermesIntegration } from "./HermesIntegration";

const originalFetch = globalThis.fetch;

const mockStatus = {
  ok: true,
  server: { version: "1.23.0", uptimeMs: 5000 },
  integrations: {
    agentActivity: { available: true },
    steer: { available: true },
    planGate: { available: true },
  },
  config: {
    planGateDefault: false,
    activityRateLimitMs: 2000,
  },
};

const renderComponent = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <HermesIntegration />
    </I18nProvider>,
  );

describe("HermesIntegration", () => {
  beforeEach(() => {
    // SAFETY: mock() returns a callable mock; the test harness only needs a fetch-like function.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockStatus), { status: 200 }))
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useUIStore.setState({ hermesPlanGateDefault: false });
  });

  test("renders the Hermes title and description", () => {
    const markup = renderComponent();
    expect(markup).toContain("Hermes");
    expect(markup).toContain("Agent-to-agent integration");
  });

  test("renders the collapsible trigger with status indicator", () => {
    const markup = renderComponent();
    expect(markup).toContain("integrations.hermes");
    expect(markup).toContain("Checking…");
  });

  test("does not render collapsed content in SSR", () => {
    const markup = renderComponent();
    expect(markup).not.toContain("Activity stream");
    expect(markup).not.toContain("Require plan approval by default");
  });

  test("toggling plan gate default updates the store", () => {
    const state = useUIStore.getState();
    expect(state.hermesPlanGateDefault).toBe(false);

    state.setHermesPlanGateDefault(true);
    expect(useUIStore.getState().hermesPlanGateDefault).toBe(true);

    state.setHermesPlanGateDefault(false);
    expect(useUIStore.getState().hermesPlanGateDefault).toBe(false);
  });
});
