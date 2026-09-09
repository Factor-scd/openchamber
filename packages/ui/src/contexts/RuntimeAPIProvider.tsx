import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { createContentCachedFiles } from '@/contexts/content-cache-owner';
import {
  resolveActiveRuntimeAPIs,
  subscribeRuntimeProviderChanged,
} from '@/lib/runtime-api-registry';

type ContentCachedFiles = ReturnType<typeof createContentCachedFiles>;

interface RuntimeAPIProviderProps {
  /** Runtime APIs to provide. Ignored when a registry provider is active. */
  apis: RuntimeAPIs;
  children: ReactNode;
}

/**
 * Provides RuntimeAPIs to the React tree. When a provider is registered in
 * the runtime API registry, the component automatically re-resolves the APIs
 * on provider switches. Otherwise it uses the `apis` prop directly (legacy
 * behaviour, fully backward compatible).
 */
export function RuntimeAPIProvider({ apis: fallbackApis, children }: RuntimeAPIProviderProps): JSX.Element {
  const [registryApis, setRegistryApis] = React.useState<RuntimeAPIs | null>(() =>
    resolveActiveRuntimeAPIs(),
  );

  React.useEffect(() => {
    return subscribeRuntimeProviderChanged(() => {
      setRegistryApis(resolveActiveRuntimeAPIs());
    });
  }, []);

  const apis = registryApis ?? fallbackApis;

  // Effect-owned lifecycle: React Strict Mode dispose+remount must create a fresh
  // owner. useMemo + dispose reused a dead owner and broke text-file opens
  // (binaries skipped the pre-read, so they still appeared to work).
  const [cachedOwner, setCachedOwner] = React.useState<ContentCachedFiles | null>(null);

  React.useEffect(() => {
    const owner = createContentCachedFiles(apis.files);
    setCachedOwner(owner);
    return () => {
      owner.dispose();
      setCachedOwner((current) => (current === owner ? null : current));
    };
  }, [apis.files]);

  const files: FilesAPI = cachedOwner?.files ?? apis.files;
  const cachedApis = React.useMemo<RuntimeAPIs>(
    () => ({
      ...apis,
      files,
    }),
    [apis, files],
  );
  return <RuntimeAPIContext.Provider value={cachedApis}>{children}</RuntimeAPIContext.Provider>;
}
