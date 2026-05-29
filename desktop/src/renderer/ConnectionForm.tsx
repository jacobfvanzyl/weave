import { useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, Loader2, Server, Trash2, Wifi } from 'lucide-react';
import { Button } from '@weave/client/components/ui/button';
import { Input } from '@weave/client/components/ui/input';
import { Label } from '@weave/client/components/ui/label';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
} from '../shared/desktop-api';

type ConnectionFormProps = {
  settings: DesktopConnectionSettings;
  status?: 'checking' | 'connected' | 'disconnected';
  error?: string;
  compact?: boolean;
  onCancel?: () => void;
  onSave: (input: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  onTest: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
};

const buildInput = (mastraUrl: string, authToken: string, clearToken: boolean): DesktopConnectionInput => {
  if (clearToken) return { mastraUrl, authToken: null };
  const trimmedToken = authToken.trim();
  return trimmedToken ? { mastraUrl, authToken: trimmedToken } : { mastraUrl };
};

const ConnectionForm = ({
  settings,
  status,
  error,
  compact = false,
  onCancel,
  onSave,
  onTest,
}: ConnectionFormProps) => {
  const [mastraUrl, setMastraUrl] = useState(settings.mastraUrl);
  const [authToken, setAuthToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | undefined>();
  const [lastResult, setLastResult] = useState<DesktopConnectionTestResult | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending('save');
    const result = await onSave(buildInput(mastraUrl, authToken, clearToken));
    setLastResult(result);
    setPending(undefined);
  };

  const test = async () => {
    setPending('test');
    const result = await onTest(buildInput(mastraUrl, authToken, clearToken));
    setLastResult(result);
    setPending(undefined);
  };

  const hasStoredToken = settings.hasAuthToken && !clearToken;
  const resultError = lastResult && !lastResult.ok ? lastResult.error : undefined;
  const resultOk = lastResult?.ok;

  return (
    <form className={compact ? 'space-y-5' : 'w-full max-w-md space-y-6'} onSubmit={submit}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-mauve">
          <Server size={18} />
          <h1 className="text-lg font-semibold text-foreground">Weave Server</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect this desktop client to the running Weave server.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="mastra-url">Server URL</Label>
          <Input
            id="mastra-url"
            nativeInput
            autoComplete="url"
            value={mastraUrl}
            onChange={event => setMastraUrl(event.currentTarget.value)}
            placeholder="http://localhost:4111"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="auth-token">Auth token</Label>
          <div className="flex gap-2">
            <Input
              id="auth-token"
              nativeInput
              autoComplete="off"
              type="password"
              value={authToken}
              disabled={clearToken}
              onChange={event => setAuthToken(event.currentTarget.value)}
              placeholder={hasStoredToken ? 'Stored token will be reused' : 'WEAVE_AUTH_TOKEN'}
            />
            {settings.hasAuthToken ? (
              <Button
                aria-label={clearToken ? 'Keep stored token' : 'Clear stored token'}
                className="shrink-0"
                size="icon"
                type="button"
                variant={clearToken ? 'secondary' : 'outline'}
                onClick={() => {
                  setClearToken(value => !value);
                  setAuthToken('');
                }}
              >
                <Trash2 size={16} />
              </Button>
            ) : null}
          </div>
          <div className="flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound size={13} />
            {clearToken ? 'Stored token will be removed.' : 'Tokens are encrypted by the main process when available.'}
          </div>
        </div>
      </div>

      <div className="min-h-5 text-sm">
        {pending ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="animate-spin" size={15} />
            {pending === 'save' ? 'Saving...' : 'Testing...'}
          </span>
        ) : resultOk ? (
          <span className="inline-flex items-center gap-2 text-success">
            <CheckCircle2 size={15} />
            Connected.
          </span>
        ) : (
          <span className="text-destructive">{resultError ?? error ?? (status === 'checking' ? 'Checking...' : '')}</span>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={test} disabled={Boolean(pending)}>
          <Wifi size={16} />
          Test
        </Button>
        <Button type="submit" disabled={Boolean(pending)}>
          Save
        </Button>
      </div>
    </form>
  );
};

export const ConnectionScreen = (props: Omit<ConnectionFormProps, 'compact' | 'onCancel'>) => (
  <main className="grid h-dvh place-items-center bg-background px-6">
    <ConnectionForm {...props} />
  </main>
);

export const ConnectionDialog = ({
  open,
  onOpenChange,
  ...props
}: Omit<ConnectionFormProps, 'compact' | 'onCancel'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-md">
      <div className="w-full max-w-md rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-2xl">
        <ConnectionForm {...props} compact onCancel={() => onOpenChange(false)} />
      </div>
    </div>
  );
};
