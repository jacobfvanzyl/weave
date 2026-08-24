import type { FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link01Icon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';

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
    <main className="flex min-h-svh items-center justify-center bg-background p-4 text-foreground">
      <Empty className="max-w-md p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>Connect Alpha to Portal</EmptyTitle>
          <EmptyDescription>
            This temporary surface preserves the direct-host connection while
            the product shell is rebuilt.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <form className="w-full" onSubmit={submit}>
            <FieldSet disabled={connecting}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="portal-url">Portal URL</FieldLabel>
                  <Input
                    id="portal-url"
                    inputMode="url"
                    value={model.connection.hostUrl}
                    onChange={(event) => actions.setHostUrl(event.target.value)}
                  />
                </Field>
                <Field data-invalid={Boolean(model.error)}>
                  <FieldLabel htmlFor="portal-token">Access token</FieldLabel>
                  <Input
                    id="portal-token"
                    type="password"
                    autoComplete="off"
                    placeholder="Required"
                    value={model.accessToken}
                    aria-invalid={Boolean(model.error)}
                    onChange={(event) => actions.setAccessToken(event.target.value)}
                  />
                  <FieldDescription>
                    The token stays in memory and is never placed in the URL.
                  </FieldDescription>
                  {model.error && <FieldError>{model.error}</FieldError>}
                </Field>
                <Button type="submit" disabled={connecting || !model.accessToken}>
                  {connecting ? 'Connecting…' : 'Connect to Portal'}
                </Button>
              </FieldGroup>
            </FieldSet>
          </form>
          {model.error && (
            <Alert variant="destructive">
              <AlertTitle>Connection failed</AlertTitle>
              <AlertDescription>{model.error}</AlertDescription>
            </Alert>
          )}
        </EmptyContent>
      </Empty>
    </main>
  );
}
