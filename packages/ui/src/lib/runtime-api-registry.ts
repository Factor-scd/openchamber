import type { RuntimeAPIs } from '@/lib/api/types';

/**
 * A factory that creates RuntimeAPIs for a named runtime.
 *
 * The factory is called each time the provider becomes active (or the
 * endpoint changes while it is active), so it must be cheap and side-effect
 * free beyond returning the APIs object.
 */
export type RuntimeAPIProviderFactory = () => RuntimeAPIs;

export type RuntimeAPIProviderChangedDetail = {
  previous: string | null;
  current: string | null;
};

const RUNTIME_API_PROVIDER_CHANGED_EVENT = 'openchamber:runtime-api-provider-changed';

// ---- Provider registry --------------------------------------------------

const providers = new Map<string, RuntimeAPIProviderFactory>();
let activeProviderName: string | null = null;

/**
 * Register a named provider factory. Overwrites any previous factory with
 * the same name. Does NOT activate the provider — call
 * `setActiveRuntimeProvider` separately.
 */
export const registerRuntimeProvider = (name: string, factory: RuntimeAPIProviderFactory): void => {
  providers.set(name, factory);
};

/**
 * Remove a provider from the registry. If it was the active provider, the
 * active slot is cleared.
 */
export const unregisterRuntimeProvider = (name: string): void => {
  providers.delete(name);
  if (activeProviderName === name) {
    activeProviderName = null;
  }
};

/**
 * Look up a registered provider by name, or the currently active provider
 * when `name` is omitted.
 */
export const getRuntimeProvider = (name?: string): RuntimeAPIProviderFactory | undefined => {
  const key = name ?? activeProviderName;
  return key != null ? providers.get(key) : undefined;
};

/**
 * Return the name of the currently active provider, or null when none is
 * active.
 */
export const getActiveRuntimeProviderName = (): string | null => activeProviderName;

/**
 * Return the names of all registered providers.
 */
export const listRuntimeProviders = (): string[] => [...providers.keys()];

/**
 * Switch the active provider. Throws when the name does not match a
 * registered provider. Emits a DOM custom event so React subscribers
 * (RuntimeAPIProvider) can re-resolve the APIs.
 */
export const setActiveRuntimeProvider = (name: string): void => {
  if (!providers.has(name)) {
    throw new Error(`Runtime provider "${name}" is not registered`);
  }
  const previous = activeProviderName;
  if (previous === name) return;
  activeProviderName = name;
  emitProviderChanged({ previous, current: name });
};

// ---- Change subscription ------------------------------------------------

export const subscribeRuntimeProviderChanged = (
  callback: (detail: RuntimeAPIProviderChangedDetail) => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeAPIProviderChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_API_PROVIDER_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_API_PROVIDER_CHANGED_EVENT, listener);
};

function emitProviderChanged(detail: RuntimeAPIProviderChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<RuntimeAPIProviderChangedDetail>(RUNTIME_API_PROVIDER_CHANGED_EVENT, { detail }),
  );
}

// ---- High-level helpers -------------------------------------------------

/**
 * Resolve the RuntimeAPIs for the currently active provider. Returns null
 * when no provider is registered or active.
 */
export const resolveActiveRuntimeAPIs = (): RuntimeAPIs | null => {
  const factory = getRuntimeProvider();
  return factory ? factory() : null;
};
