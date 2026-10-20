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
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FormValues = Partial<Record<string, ElicitationContentValue>>;
type FormErrors = Record<string, string>;
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

const fieldDetails = (name: string, schema: ElicitationPropertySchema) => {
  const details = schema as { title?: unknown; description?: unknown };
  return {
    label: typeof details.title === 'string' ? details.title : name,
    description: typeof details.description === 'string' ? details.description : undefined,
  };
};

const validateField = (
  name: string,
  schema: ElicitationPropertySchema,
  value: ElicitationContentValue | undefined,
  required: boolean,
) => {
  const { label } = fieldDetails(name, schema);
  if (value === undefined) return required ? `${label} is required.` : undefined;

  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${label} must be text.`;
    const stringSchema = schema as StringPropertySchema;
    if (stringSchema.minLength != null && value.length < stringSchema.minLength) {
      return `${label} must be at least ${stringSchema.minLength} characters.`;
    }
    if (stringSchema.maxLength != null && value.length > stringSchema.maxLength) {
      return `${label} must be at most ${stringSchema.maxLength} characters.`;
    }
    if (stringSchema.pattern) {
      try {
        if (!new RegExp(stringSchema.pattern).test(value)) return `${label} has an invalid format.`;
      } catch {
        return `${label} has an invalid format.`;
      }
    }
    if (stringSchema.format === 'email' && value && !/^\S+@\S+\.\S+$/.test(value)) {
      return `${label} must be a valid email address.`;
    }
    if (stringSchema.format === 'uri' && value) {
      try {
        new URL(value);
      } catch {
        return `${label} must be a valid URL.`;
      }
    }
    if ((stringSchema.format === 'date' || stringSchema.format === 'date-time')
      && value
      && Number.isNaN(Date.parse(value))) {
      return `${label} must be a valid ${stringSchema.format}.`;
    }
    const options = enumOptions(schema).map((option) => option.value);
    if (options.length > 0 && !options.includes(value)) return `${label} must be one of the available options.`;
    return undefined;
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number.`;
    if (schema.type === 'integer' && !Number.isInteger(value)) return `${label} must be a whole number.`;
    const numberSchema = schema as { minimum?: number | null; maximum?: number | null };
    if (numberSchema.minimum != null && value < numberSchema.minimum) {
      return `${label} must be at least ${numberSchema.minimum}.`;
    }
    if (numberSchema.maximum != null && value > numberSchema.maximum) {
      return `${label} must be at most ${numberSchema.maximum}.`;
    }
    return undefined;
  }

  if (schema.type === 'boolean') {
    return typeof value === 'boolean' ? undefined : `${label} must be true or false.`;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${label} must be a selection.`;
    const arraySchema = schema as MultiSelectPropertySchema;
    if (arraySchema.minItems != null && value.length < arraySchema.minItems) {
      return `Select at least ${arraySchema.minItems} ${label} options.`;
    }
    if (arraySchema.maxItems != null && value.length > arraySchema.maxItems) {
      return `Select at most ${arraySchema.maxItems} ${label} options.`;
    }
  }

  return undefined;
};

const validateForm = (form: FormRequest, values: FormValues) => {
  const required = new Set(form.requestedSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(form.requestedSchema.properties ?? {}).flatMap(([name, schema]) => {
      const error = validateField(name, schema, values[name], required.has(name));
      return error ? [[name, error]] : [];
    }),
  ) as FormErrors;
};

function FormField({
  name,
  schema,
  value,
  error,
  onChange,
}: {
  name: string;
  schema: ElicitationPropertySchema;
  value: ElicitationContentValue | undefined;
  error?: string;
  onChange(value: ElicitationContentValue | undefined): void;
}) {
  const { label, description } = fieldDetails(name, schema);
  const options = enumOptions(schema);

  if (schema.type === 'boolean') {
    return (
      <Field orientation="horizontal" data-invalid={Boolean(error)}>
        <Checkbox
          aria-invalid={Boolean(error)}
          id={`elicitation-${name}`}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
        <FieldContent>
          <FieldLabel htmlFor={`elicitation-${name}`}>{label}</FieldLabel>
          {description && <FieldDescription>{description}</FieldDescription>}
          <FieldError>{error}</FieldError>
        </FieldContent>
      </Field>
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
      <FieldSet data-invalid={Boolean(error)}>
        <FieldLegend variant="label">{label}</FieldLegend>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldGroup data-slot="checkbox-group" className="gap-2">
          {choices.map((choice) => {
            const choiceId = `elicitation-${name}-${choice.value}`;
            return (
              <Field key={choice.value} orientation="horizontal">
                <Checkbox
                  aria-invalid={Boolean(error)}
                  id={choiceId}
                  checked={selected.includes(choice.value)}
                  onCheckedChange={(checked) => onChange(
                    checked
                      ? [...selected, choice.value]
                      : selected.filter((item) => item !== choice.value),
                  )}
                />
                <FieldLabel htmlFor={choiceId} className="font-normal">
                  {choice.label}
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
        <FieldError>{error}</FieldError>
      </FieldSet>
    );
  }

  if (options.length > 0) {
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={`elicitation-${name}`}>{label}</FieldLabel>
        <Select
          items={options}
          value={typeof value === 'string' ? value : ''}
          onValueChange={(next) => onChange(String(next))}
        >
          <SelectTrigger id={`elicitation-${name}`} className="w-full" aria-invalid={Boolean(error)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{label}</SelectLabel>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    const numberSchema = schema as { minimum?: number | null; maximum?: number | null };
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={`elicitation-${name}`}>{label}</FieldLabel>
        <Input
          id={`elicitation-${name}`}
          type="number"
          step={schema.type === 'integer' ? 1 : 'any'}
          min={numberSchema.minimum ?? undefined}
          max={numberSchema.maximum ?? undefined}
          aria-invalid={Boolean(error)}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) => onChange(
            event.target.value === '' ? undefined : Number(event.target.value),
          )}
        />
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }

  if (schema.type === 'string') {
    const stringSchema = schema as StringPropertySchema;
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={`elicitation-${name}`}>{label}</FieldLabel>
        <Input
          id={`elicitation-${name}`}
          type={stringSchema.format === 'email'
            ? 'email'
            : stringSchema.format === 'uri'
              ? 'url'
              : stringSchema.format === 'date'
                ? 'date'
                : stringSchema.format === 'date-time'
                  ? 'datetime-local'
                  : 'text'}
          minLength={stringSchema.minLength ?? undefined}
          maxLength={stringSchema.maxLength ?? undefined}
          pattern={stringSchema.pattern ?? undefined}
          aria-invalid={Boolean(error)}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }

  return (
    <Alert>
      <AlertTitle>Unsupported field</AlertTitle>
      <AlertDescription><code>{name}</code> ({schema.type})</AlertDescription>
    </Alert>
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
    Object.entries(properties).flatMap(([name, schema]) => {
      const value = (schema as { default?: unknown }).default;
      return value == null ? [] : [[name, value as ElicitationContentValue]];
    }),
  ), [properties]);
  const [values, setValues] = useState<FormValues>(defaults);
  const [errors, setErrors] = useState<FormErrors>({});

  return (
    <form
      aria-label={form.message}
      className="grid gap-3 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const nextErrors = validateForm(form, values);
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        onRespond(entry.requestId, { action: 'accept', content: values });
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{form.message}</span>
        <Badge className="ml-auto" variant="outline">Input requested</Badge>
      </div>
      <FieldGroup className="gap-3 sm:grid sm:grid-cols-2">
        {Object.entries(properties).map(([name, schema]) => (
          <FormField
            key={name}
            name={name}
            schema={schema}
            value={values[name]}
            error={errors[name]}
            onChange={(value) => {
              setValues((current) => {
                if (value !== undefined) return { ...current, [name]: value };
                const { [name]: _removed, ...remaining } = current;
                return remaining;
              });
              setErrors((current) => {
                if (!(name in current)) return current;
                const { [name]: _removed, ...remaining } = current;
                return remaining;
              });
            }}
          />
        ))}
      </FieldGroup>
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
      <Alert>
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.75} />
        <AlertTitle>{url.message}</AlertTitle>
        <AlertDescription className="truncate">{url.url}</AlertDescription>
        {entry.status === 'pending' && (
          <AlertAction className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRespond(entry.requestId, { action: 'decline' })}
            >
              Decline
            </Button>
            <Button
              render={<a href={url.url} rel="noreferrer" target="_blank" />}
              nativeButton={false}
              size="sm"
              variant="outline"
              onClick={() => onRespond(entry.requestId, { action: 'accept' })}
            >
              Open
              <HugeiconsIcon data-icon="inline-end" icon={ArrowUpRight01Icon} strokeWidth={1.75} />
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  }
  return (
    <Alert>
      <AlertTitle className="flex items-center gap-2">
        {entry.request.message}
        <Badge className="ml-auto" variant="outline">{entry.request.mode}</Badge>
      </AlertTitle>
      <AlertDescription>
        <pre className="overflow-x-auto whitespace-pre-wrap">
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
      </AlertDescription>
    </Alert>
  );
}
