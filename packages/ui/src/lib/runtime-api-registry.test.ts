import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeAPIs } from '@/lib/api/types';
import {
  registerRuntimeProvider,
  unregisterRuntimeProvider,
  getRuntimeProvider,
  getActiveRuntimeProviderName,
  listRuntimeProviders,
  setActiveRuntimeProvider,
  resolveActiveRuntimeAPIs,
  subscribeRuntimeProviderChanged,
} from './runtime-api-registry';

const stubApis = (platform: string): RuntimeAPIs => ({
  runtime: { platform: platform as 'web' | 'desktop' | 'vscode', isDesktop: false, isVSCode: false, label: platform },
  terminal: {} as RuntimeAPIs['terminal'],
  git: {} as RuntimeAPIs['git'],
  files: {} as RuntimeAPIs['files'],
  settings: {} as RuntimeAPIs['settings'],
  permissions: {} as RuntimeAPIs['permissions'],
  notifications: {} as RuntimeAPIs['notifications'],
  tools: {} as RuntimeAPIs['tools'],
});

// Ensure window is available for DOM event dispatch in bun test environment
const ensureWindow = () => {
  if (typeof globalThis.window === 'undefined') {
    (globalThis as Record<string, unknown>).window = globalThis;
  }
  if (typeof globalThis.CustomEvent === 'undefined') {
    (globalThis as Record<string, unknown>).CustomEvent = class CustomEvent<T = unknown> extends Event {
      detail: T;
      constructor(type: string, options?: CustomEventInit<T>) {
        super(type, options);
        this.detail = options?.detail as T;
      }
    };
  }
};

describe('runtime-api-registry', () => {
  beforeEach(() => {
    ensureWindow();
    // Clean up all registered providers between tests
    for (const name of listRuntimeProviders()) {
      unregisterRuntimeProvider(name);
    }
  });

  test('registerRuntimeProvider makes a provider retrievable', () => {
    const factory = () => stubApis('web');
    registerRuntimeProvider('web', factory);
    expect(getRuntimeProvider('web')).toBe(factory);
  });

  test('listRuntimeProviders returns all registered names', () => {
    registerRuntimeProvider('a', () => stubApis('a'));
    registerRuntimeProvider('b', () => stubApis('b'));
    expect(listRuntimeProviders()).toEqual(expect.arrayContaining(['a', 'b']));
  });

  test('unregisterRuntimeProvider removes a provider', () => {
    registerRuntimeProvider('temp', () => stubApis('temp'));
    unregisterRuntimeProvider('temp');
    expect(getRuntimeProvider('temp')).toBeUndefined();
  });

  test('unregisterRuntimeProvider clears active when removing the active provider', () => {
    registerRuntimeProvider('temp', () => stubApis('temp'));
    setActiveRuntimeProvider('temp');
    expect(getActiveRuntimeProviderName()).toBe('temp');
    unregisterRuntimeProvider('temp');
    expect(getActiveRuntimeProviderName()).toBeNull();
  });

  test('setActiveRuntimeProvider switches the active provider', () => {
    registerRuntimeProvider('web', () => stubApis('web'));
    registerRuntimeProvider('vscode', () => stubApis('vscode'));
    setActiveRuntimeProvider('web');
    expect(getActiveRuntimeProviderName()).toBe('web');
    setActiveRuntimeProvider('vscode');
    expect(getActiveRuntimeProviderName()).toBe('vscode');
  });

  test('setActiveRuntimeProvider throws for unknown provider', () => {
    expect(() => setActiveRuntimeProvider('nonexistent')).toThrow('not registered');
  });

  test('setActiveRuntimeProvider is idempotent for the same name', () => {
    registerRuntimeProvider('web', () => stubApis('web'));
    setActiveRuntimeProvider('web');
    // Second call with same name should not throw or change anything
    setActiveRuntimeProvider('web');
    expect(getActiveRuntimeProviderName()).toBe('web');
  });

  test('resolveActiveRuntimeAPIs returns the APIs from the active provider', () => {
    registerRuntimeProvider('web', () => stubApis('web'));
    setActiveRuntimeProvider('web');
    const apis = resolveActiveRuntimeAPIs();
    expect(apis?.runtime.label).toBe('web');
  });

  test('resolveActiveRuntimeAPIs returns null when no provider is active', () => {
    expect(resolveActiveRuntimeAPIs()).toBeNull();
  });

  test('getRuntimeProvider without args returns the active provider', () => {
    registerRuntimeProvider('web', () => stubApis('web'));
    setActiveRuntimeProvider('web');
    expect(getRuntimeProvider()).toBeDefined();
  });

  test('subscribeRuntimeProviderChanged fires on provider switch', () => {
    registerRuntimeProvider('a', () => stubApis('a'));
    registerRuntimeProvider('b', () => stubApis('b'));

    const callback = vi.fn();
    const unsub = subscribeRuntimeProviderChanged(callback);

    setActiveRuntimeProvider('a');
    expect(callback).toHaveBeenCalledWith({ previous: null, current: 'a' });

    setActiveRuntimeProvider('b');
    expect(callback).toHaveBeenCalledWith({ previous: 'a', current: 'b' });

    unsub();
  });

  test('subscribeRuntimeProviderChanged unsubscribes correctly', () => {
    registerRuntimeProvider('a', () => stubApis('a'));
    registerRuntimeProvider('b', () => stubApis('b'));

    const callback = vi.fn();
    const unsub = subscribeRuntimeProviderChanged(callback);

    setActiveRuntimeProvider('a');
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();
    setActiveRuntimeProvider('b');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('registerRuntimeProvider overwrites a previous factory with the same name', () => {
    const factory1 = () => stubApis('web');
    const factory2 = () => stubApis('desktop');
    registerRuntimeProvider('web', factory1);
    registerRuntimeProvider('web', factory2);
    expect(getRuntimeProvider('web')).toBe(factory2);
  });
});
