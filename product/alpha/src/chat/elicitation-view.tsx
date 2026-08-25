import { useMemo, useState } from 'react';
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
  MultiSelectPropertySchema,
  StringPropertySchema,
} from '@agentclientprotocol/sdk';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import type { TranscriptElicitation } from './acp-transcript';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

type FormValues = Record<string, ElicitationContentValue>;
type FormRequest = CreateElicitationRequest & {
  mode: 'form';
  requestedSchema: ElicitationSchema;
};
type UrlRequest = CreateElicitationRequest & {
  mode: 'url';
  elicitationId: string;
  url: string;
};

const formRequest = (request: CreateElicitationRequest): FormRequest | undefined => {
  const schema = (request as Record<string, unknown>).requestedSchema;
  return request.mode === 'form' && typeof schema === 'object' && schema !== null
    ? request as FormRequest
    : undefined;
};

const urlRequest = (request: CreateElicitationRequest): UrlRequest | undefined => {
  const url = (request as Record<string, unknown>).url;
  const elicitationId = (request as Record<string, unknown>).elicitationId;
  return request.mode === 'url'
    && typeof url === 'string'
    && typeof elicitationId === 'string'
    ? request as UrlRequest
    : undefined;
};

const defaultValue = (schema: ElicitationPropertySchema): ElicitationContentValue => {
  const fallback = (schema as { default?: unknown }).default;
  if (fallback != null) {
    return fallback as ElicitationContentValue;
  }
  switch (schema.type) {
    case 'boolean': return false;
    case 'number':
    case 'integer': return 0;
    case 'array': return [];
    default: return '';
  }
};

const enumOptions = (schema: ElicitationPropertySchema) => {
  if (schema.type !== 'string') return [];
  const stringSchema = schema as StringPropertySchema;
  if (Array.isArray(stringSchema.oneOf)) {
    return stringSchema.oneOf.map((option) => ({
      value: option.const,
      label: option.title,
    }));
  }
  if (Array.isArray(stringSchema.enum)) {
    return stringSchema.enum.map((value) => ({ value, label: value }));
  }
  return [];
};

function FormField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: ElicitationPropertySchema;
  value: ElicitationContentValue;
  onChange(value: ElicitationContentValue): void;
}) {
  const details = schema as { title?: unknown; description?: unknown };
  const label = typeof details.title === 'string' ? details.title : name;
  const description = typeof details.description === 'string'
    ? details.description
    : undefined;
  const options = enumOptions(schema);

  if (schema.type === 'boolean') {
    return (
      <div className="flex items-start gap-2">
        <Checkbox
          id={`elicitation-${name}`}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`elicitation-${name}`}>{label}</Label>
          {description && <p className="text-[0.625rem] text-muted-foreground">{description}</p>}
        </div>
      </div>
    );
  }

  if (schema.type === 'array') {
    const items = (schema as MultiSelectPropertySchema).items;
    const itemRecord = items as Record<string, unknown>;
    const enumValues = Array.isArray(itemRecord.enum)
      ? itemRecord.enum.filter((item): item is string => typeof item === 'string')
      : [];
    const titledValues = Array.isArray(itemRecord.anyOf)
      ? itemRecord.anyOf.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return [];
          const option = item as Record<string, unknown>;
          return typeof option.const === 'string' && typeof option.title === 'string'
            ? [{ value: option.const, label: option.title }]
            : [];
        })
      : [];
    const choices: { value: string; label: string }[] = enumValues.length > 0
      ? enumValues.map((item) => ({ value: item, label: item }))
      : titledValues;
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="grid gap-1.5">
        <legend className="text-xs font-medium">{label}</legend>
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={selected.includes(choice.value)}
              onCheckedChange={(checked) => onChange(
                checked
                  ? [...selected, choice.value]
                  : selected.filter((item) => item !== choice.value),
              )}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
    );
  }

  if (options.length > 0) {
    return (
      <div className="grid gap-1">
        <Label htmlFor={`elicitation-${name}`}>{label}</Label>
        <Select value={String(value)} onValueChange={(next) => onChange(String(next))}>
          <SelectTrigger id={`elicitation-${name}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <div className="grid gap-1">
        <Label htmlFor={`elicitation-${name}`}>{label}</Label>
        <Input
          id={`elicitation-${name}`}
          type="number"
          step={schema.type === 'integer' ? 1 : 'any'}
          value={Number(value)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    );
  }

  if (schema.type === 'string') {
    const stringSchema = schema as StringPropertySchema;
    return (
      <div className="grid gap-1">
        <Label htmlFor={`elicitation-${name}`}>{label}</Label>
        <Input
          id={`elicitation-${name}`}
          type={stringSchema.format === 'email' ? 'email' : stringSchema.format === 'uri' ? 'url' : 'text'}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
        {description && <p className="text-[0.625rem] text-muted-foreground">{description}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-dashed p-2 text-[0.6875rem] text-muted-foreground">
      Unsupported field <code>{name}</code> ({schema.type})
    </div>
  );
}

function ElicitationForm({
  entry,
  onRespond,
}: {
  entry: TranscriptElicitation;
  onRespond(requestId: string, response: CreateElicitationResponse): void;
}) {
  const request = entry.request;
  const form = formRequest(request);
  if (!form) return null;
  const properties = form.requestedSchema.properties ?? {};
  const defaults = useMemo(() => Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [name, defaultValue(schema)]),
  ), [properties]);
  const [values, setValues] = useState<FormValues>(defaults);

  return (
    <form
      aria-label={form.message}
      className="grid gap-3 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRespond(entry.requestId, { action: 'accept', content: values });
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{form.message}</span>
        <Badge className="ml-auto" variant="outline">Input requested</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(properties).map(([name, schema]) => (
          <FormField
            key={name}
            name={name}
            schema={schema}
            value={values[name] ?? defaultValue(schema)}
            onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
          />
        ))}
      </div>
      {entry.status === 'pending' && (
        <div className="flex justify-end gap-1.5 border-t pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onRespond(entry.requestId, { action: 'decline' })}
          >
            Decline
          </Button>
          <Button type="submit">Submit</Button>
        </div>
      )}
    </form>
  );
}

export function ElicitationView({
  entry,
  onRespond,
}: {
  entry: TranscriptElicitation;
  onRespond(requestId: string, response: CreateElicitationResponse): void;
}) {
  if (formRequest(entry.request)) {
    return <ElicitationForm entry={entry} onRespond={onRespond} />;
  }
  const url = urlRequest(entry.request);
  if (url) {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-info-background p-3">
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.75} className="size-4 text-info" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{url.message}</p>
          <p className="truncate text-[0.625rem] text-muted-foreground">{url.url}</p>
        </div>
        {entry.status === 'pending' && (
          <a
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            href={url.url}
            rel="noreferrer"
            target="_blank"
          >
            Open
            <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={1.75} />
          </a>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed p-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium">{entry.request.message}</p>
        <Badge className="ml-auto" variant="outline">{entry.request.mode}</Badge>
      </div>
      <pre className="mt-2 overflow-x-auto text-[0.6875rem] text-muted-foreground whitespace-pre-wrap">
        {JSON.stringify(entry.request, null, 2)}
      </pre>
      {entry.status === 'pending' && (
        <Button
          className="mt-2"
          size="sm"
          variant="ghost"
          onClick={() => onRespond(entry.requestId, { action: 'cancel' })}
        >
          Dismiss
        </Button>
      )}
    </div>
  );
}
