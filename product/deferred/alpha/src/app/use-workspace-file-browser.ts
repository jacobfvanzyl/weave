import { useEffect, useRef, useState } from 'react';
import type { WorkspaceFileWatchEvent } from '@weave/product-protocol';
import { DirectHostClient, PortalRpcError, PortalTransportError } from '@/portal-client';
import type { AlphaWorkspaceFiles } from './alpha-controller';

type WorkspaceFileWatch = Awaited<ReturnType<DirectHostClient['watchWorkspaceFiles']>>;

export function useWorkspaceFileBrowser() {
  const [files, setFiles] = useState<AlphaWorkspaceFiles>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const filesRef = useRef<AlphaWorkspaceFiles | undefined>(undefined);
  const watchRef = useRef<WorkspaceFileWatch | undefined>(undefined);
  const watchGeneration = useRef(0);
  const clientRef = useRef<DirectHostClient | undefined>(undefined);

  const replaceFiles = (next: AlphaWorkspaceFiles | undefined) => {
    filesRef.current = next;
    setFiles(next);
  };

  const disposeWatch = () => {
    watchGeneration.current += 1;
    const watch = watchRef.current;
    watchRef.current = undefined;
    void watch?.close();
  };

  const close = () => {
    disposeWatch();
    replaceFiles(undefined);
    setBusy(false);
    setError(undefined);
    clientRef.current = undefined;
  };

  useEffect(() => () => disposeWatch(), []);

  const refreshFromWatch = async (
    activeClient: DirectHostClient,
    workspaceId: string,
    generation: number,
    event: WorkspaceFileWatchEvent,
  ) => {
    const current = filesRef.current;
    if (generation !== watchGeneration.current || !current || current.workspaceId !== workspaceId) return;
    try {
      const directoryPaths = Object.keys(current.directories);
      const listedDirectories = await Promise.all(directoryPaths.map(async (path) => {
        const listed = await activeClient.listWorkspaceFiles(workspaceId, path);
        return [path, { entries: listed.entries, truncated: listed.truncated }] as const;
      }));
      const latest = filesRef.current;
      if (generation !== watchGeneration.current || !latest || latest.workspaceId !== workspaceId) return;
      replaceFiles({
        ...latest,
        directories: {
          ...latest.directories,
          ...Object.fromEntries(listedDirectories),
        },
        openFiles: latest.openFiles.map((file) =>
          file.kind === 'text'
            && (event.rescan === true || event.paths.includes(file.path))
            ? { ...file, changed: true }
            : file
        ),
      });
    } catch (cause) {
      if (!(cause instanceof PortalTransportError)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const startWatch = async (activeClient: DirectHostClient, workspaceId: string) => {
    disposeWatch();
    const generation = watchGeneration.current;
    const watch = await activeClient.watchWorkspaceFiles(workspaceId, [''], (event) => {
      void refreshFromWatch(activeClient, workspaceId, generation, event);
    });
    if (generation !== watchGeneration.current) {
      await watch.close();
      return;
    }
    watchRef.current = watch;
  };

  const perform = async <Result>(
    action: (activeClient: DirectHostClient) => Promise<Result>,
    handleError?: (cause: unknown) => boolean,
  ) => {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      return await action(client);
    } catch (cause) {
      if (!(cause instanceof PortalTransportError) && !handleError?.(cause)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const open = async (
    client: DirectHostClient,
    workspaceId: string,
    workspaceName: string,
    workspaceRootName?: string,
  ) => {
    disposeWatch();
    const generation = watchGeneration.current;
    clientRef.current = client;
    replaceFiles(undefined);
    return await perform(async (activeClient) => {
      const listed = await activeClient.listWorkspaceFiles(workspaceId, '');
      if (generation !== watchGeneration.current) return;
      replaceFiles({
        workspaceId,
        workspaceName,
        ...(workspaceRootName ? { workspaceRootName } : {}),
        openFiles: [],
        directories: {
          '': { entries: listed.entries, truncated: listed.truncated },
        },
      });
      await startWatch(activeClient, workspaceId);
      return true as const;
    });
  };

  const openDirectory = async (path: string) => {
    const current = filesRef.current;
    if (!current || current.directories[path]) return;
    await perform(async (activeClient) => {
      const listed = await activeClient.listWorkspaceFiles(current.workspaceId, path);
      const latest = filesRef.current;
      if (!latest || latest.workspaceId !== current.workspaceId) return;
      replaceFiles({
        ...latest,
        directories: {
          ...latest.directories,
          [path]: { entries: listed.entries, truncated: listed.truncated },
        },
      });
    });
  };

  const readFile = async (path: string) =>
    await perform(async (activeClient) => {
      const current = filesRef.current;
      if (!current) return;
      const file = await activeClient.readWorkspaceFile(current.workspaceId, path);
      const latest = filesRef.current;
      if (!latest || latest.workspaceId !== current.workspaceId) return;
      const nextFile = { ...file, kind: 'text' as const, changed: false };
      const existingIndex = latest.openFiles.findIndex((candidate) => candidate.path === path);
      replaceFiles({
        ...latest,
        openFiles: existingIndex === -1
          ? [...latest.openFiles, nextFile]
          : latest.openFiles.map((candidate, index) => index === existingIndex ? nextFile : candidate),
        activeFilePath: path,
      });
    }, (cause) => {
      const code = cause instanceof PortalRpcError && cause.data && typeof cause.data === 'object'
        ? (cause.data as { code?: unknown }).code
        : undefined;
      if (code !== 'UNSUPPORTED_CONTENT' && code !== 'PAYLOAD_TOO_LARGE') return false;
      const latest = filesRef.current;
      if (latest) {
        const nextFile = {
          kind: 'unavailable' as const,
          path,
          reason: code === 'UNSUPPORTED_CONTENT' ? 'unsupported' as const : 'too-large' as const,
        };
        const existingIndex = latest.openFiles.findIndex((candidate) => candidate.path === path);
        replaceFiles({
          ...latest,
          openFiles: existingIndex === -1
            ? [...latest.openFiles, nextFile]
            : latest.openFiles.map((candidate, index) => index === existingIndex ? nextFile : candidate),
          activeFilePath: path,
        });
      }
      return true;
    });

  const openFile = async (path: string) => {
    const current = filesRef.current;
    if (!current) return;
    if (current.openFiles.some((file) => file.path === path)) {
      replaceFiles({ ...current, activeFilePath: path });
      return;
    }
    await readFile(path);
  };

  const activateFile = (path: string) => {
    const current = filesRef.current;
    if (!current?.openFiles.some((file) => file.path === path)) return;
    replaceFiles({ ...current, activeFilePath: path });
  };

  const closeFile = (path: string) => {
    const current = filesRef.current;
    if (!current) return;
    const closingIndex = current.openFiles.findIndex((file) => file.path === path);
    if (closingIndex === -1) return;
    const openFiles = current.openFiles.filter((file) => file.path !== path);
    const activeFilePath = current.activeFilePath === path
      ? current.openFiles[closingIndex + 1]?.path ?? current.openFiles[closingIndex - 1]?.path
      : current.activeFilePath;
    replaceFiles({ ...current, openFiles, activeFilePath });
  };

  const reloadFile = async () => {
    const path = filesRef.current?.activeFilePath;
    if (path) await readFile(path);
  };

  return {
    files,
    busy,
    error,
    open,
    openDirectory,
    openFile,
    activateFile,
    closeFile,
    reloadFile,
    close,
  };
}
