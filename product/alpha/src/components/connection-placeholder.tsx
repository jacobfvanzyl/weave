import type { FormEvent } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import weaveIconUrl from '../../assets/app-icon.svg';

export function ConnectionPlaceholder({
  controller,
}: {
  controller: AlphaController;
}) {
  const { model, actions } = controller;
  const connecting = model.connection.status === 'connecting';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.connect();
  };

  return (
    <main className="flex min-h-[var(--alpha-viewport-height,100dvh)] items-center justify-center bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-foreground">
      <form className="flex w-full max-w-sm flex-col items-center gap-6 p-8" onSubmit={submit}>
        <img className="size-16" src={weaveIconUrl} alt="Weave" />
        <FieldSet className="w-full" disabled={connecting}>
          <FieldGroup>
            <Field data-disabled={connecting}>
              <FieldLabel htmlFor="portal-url">
                Portal URL
              </FieldLabel>
              <Input
                id="portal-url"
                disabled={connecting}
                inputMode="url"
                value={model.connection.hostUrl}
                onChange={(event) => actions.setHostUrl(event.target.value)}
              />
            </Field>
            <Field data-disabled={connecting} data-invalid={Boolean(model.error)}>
              <FieldLabel htmlFor="portal-token">
                Access token
              </FieldLabel>
              <Input
                id="portal-token"
                type="password"
                autoComplete="off"
                disabled={connecting}
                value={model.accessToken}
                aria-invalid={Boolean(model.error)}
                onChange={(event) => actions.setAccessToken(event.target.value)}
              />
              {model.error && (
                <FieldError className="sr-only">{model.error}</FieldError>
              )}
            </Field>
            <Button type="submit" disabled={connecting || !model.accessToken}>
              Connect
            </Button>
            {connecting && (
              <span className="sr-only" role="status" aria-live="polite">
                Connecting to Portal.
              </span>
            )}
          </FieldGroup>
        </FieldSet>
      </form>
    </main>
  );
}
