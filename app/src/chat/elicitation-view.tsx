import { useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import type {
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  MultiSelectPropertySchema,
  StringPropertySchema,
} from '@/host/protocol';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { type FormElicitation, type TranscriptElicitation, type UrlElicitation, formElicitation, urlElicitation } from './acp-transcript';
import {
  type Companion,
  type FormContent,
  type FormValues,
  answeredByOther,
  formAnswer,
  formCompanions,
  isSingleChoice,
  typedText,
} from './elicitation-conventions';
import { elicitationAnswerText, requestEndText, urlCheck } from './pending-request';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

type FormErrors = Record<string, string>;
type FormRequest = FormElicitation;
type UrlRequest = UrlElicitation;

const formRequest = formElicitation;
const urlRequest = urlElicitation;

/** One of a choice's options. */
type ChoiceOption = { value: string; label: string; description?: string };

const titledOption = (option: unknown): ChoiceOption[] => {
  const titled = typeof option === 'object' && option !== null ? option as Record<string, unknown> : {};
  if (typeof titled.const !== 'string' || typeof titled.title !== 'string') return [];
  const description = typeof titled.description === 'string' ? titled.description : undefined;
  return [{ value: titled.const, label: titled.title, description }];
};

/** A single-select's options: titled ones from `oneOf`, or `enum`'s values. */
const enumOptions = (schema: ElicitationPropertySchema): ChoiceOption[] => {
  if (schema.type !== 'string') return [];
  const stringSchema = schema as StringPropertySchema;
  if (Array.isArray(stringSchema.oneOf)) return stringSchema.oneOf.flatMap(titledOption);
  if (Array.isArray(stringSchema.enum)) return stringSchema.enum.map((value) => ({ value, label: value }));
  return [];
};

/** A multi-select's options: its items' `enum` values, or titled ones from `anyOf`. */
const multiOptions = (schema: MultiSelectPropertySchema): ChoiceOption[] => {
  const items = schema.items as Record<string, unknown>;
  const values = Array.isArray(items.enum) ? items.enum.filter((item): item is string => typeof item === 'string') : [];
  if (values.length > 0) return values.map((value) => ({ value, label: value }));
  return Array.isArray(items.anyOf) ? items.anyOf.flatMap(titledOption) : [];
};

/** A yes/no question is a choice of the two. */
const YES_NO: ChoiceOption[] = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

const fieldDetails = (name: string, schema: ElicitationPropertySchema | undefined) => {
  const details = (schema ?? {}) as { title?: unknown; description?: unknown };
  return {
    label: typeof details.title === 'string' ? details.title : name,
    description: typeof details.description === 'string' ? details.description : undefined,
  };
};

/**
 * Why `value` doesn't answer the field, if it doesn't. `other`: a choice's Claude Other answers
 * it, which counts as one more of a multi-select's picks.
 */
const validateField = (
  name: string,
  schema: ElicitationPropertySchema,
  value: ElicitationContentValue | undefined,
  required: boolean,
  other = false,
) => {
  const { label } = fieldDetails(name, schema);
  if (value === undefined && !(other && schema.type === 'array')) {
    return required && !other ? `${label} is required.` : undefined;
  }

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
    const picks = value ?? [];
    if (!Array.isArray(picks)) return `${label} must be a selection.`;
    const count = picks.length + (other ? 1 : 0);
    const arraySchema = schema as MultiSelectPropertySchema;
    if (arraySchema.minItems != null && count < arraySchema.minItems) {
      return `Select at least ${arraySchema.minItems} ${label} options.`;
    }
    if (arraySchema.maxItems != null && count > arraySchema.maxItems) {
      return `Select at most ${arraySchema.maxItems} ${label} options.`;
    }
  }

  return undefined;
};

/** What's wrong with the answer the form would send, by field. */
const validateForm = (form: FormRequest, companions: ReadonlyMap<string, Companion>, content: FormContent) => {
  const required = new Set(form.requestedSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(form.requestedSchema.properties ?? {}).flatMap(([name, schema]) => {
      const error = validateField(name, schema, content[name], required.has(name), answeredByOther(name, companions, content));
      return error ? [[name, error]] : [];
    }),
  ) as FormErrors;
};

/** A field that isn't a choice: a number or text. */
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

/** A choice's free-text companion (`elicitation-conventions.ts`), drawn as the choice's last row. */
type CompanionRow = Companion & {
  /** Its input's. */
  id: string;
  /** Its own title. */
  label: string;
  text: string;
  error?: string;
  onText(text: string): void;
};

/** An option's title, which names its control, with its description under it. */
function OptionLabel({ id, option, onClick }: { id: string; option: ChoiceOption; onClick?(event: MouseEvent): void }) {
  return (
    <FieldContent>
      <FieldLabel htmlFor={id} className="font-normal" onClick={onClick}>{option.label}</FieldLabel>
      {option.description && <FieldDescription>{option.description}</FieldDescription>}
    </FieldContent>
  );
}

/**
 * A companion's text, in line with the options' titles: under the row that names it (Claude's
 * Other), or under its own title (Codex's note). Its description, the adapter's, isn't shown.
 */
function CompanionText({
  row,
  named,
  unsent = false,
  disabled,
  inputRef,
  onFocus,
}: {
  row: CompanionRow;
  /** The row above names it. */
  named: boolean;
  /** It holds text that an option's pick leaves unsent, kept for going back to. */
  unsent?: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFocus?(): void;
}) {
  return (
    <div className="grid gap-1 pl-6" data-slot="elicitation-companion">
      {!named && <FieldLabel htmlFor={row.id} className="font-normal">{row.label}</FieldLabel>}
      <Input
        ref={inputRef}
        id={row.id}
        disabled={disabled}
        aria-invalid={Boolean(row.error)}
        className={cn(unsent && 'text-muted-foreground')}
        value={row.text}
        onFocus={onFocus}
        onChange={(event) => row.onText(event.target.value)}
      />
      <FieldError>{row.error}</FieldError>
    </div>
  );
}

/** The radio value of a single choice's Other row, apart from any option's. */
const OTHER = { other: true };

/**
 * A single choice as a list of its options, a radio group. A tap on an option (or Space on it)
 * picks it, and on the picked one takes it back, unless an answer is required; the arrow keys
 * move through the options and pick as they go. Claude's Other is one of the choices: typing in
 * it chooses it in place of an option, and picking an option keeps its text, unsent, for going
 * back to. Codex's note sits under the options, sent with the pick.
 */
function SingleChoice({
  id,
  label,
  description,
  options,
  picked,
  required,
  disabled,
  error,
  onPick,
  companion,
  otherChosen = false,
  onChooseOther,
}: {
  id: string;
  label: string;
  description?: string;
  options: ChoiceOption[];
  picked: string | undefined;
  required: boolean;
  disabled: boolean;
  error?: string;
  onPick(value: string | undefined): void;
  companion?: CompanionRow;
  /** Claude's Other is the pick. */
  otherChosen?: boolean;
  onChooseOther?(chosen: boolean): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const legendId = `${id}-legend`;
  const otherLabelId = `${id}-other`;
  const other = companion?.kind === 'replaces' ? companion : undefined;
  const typed = typedText(companion?.text) !== undefined;
  const tapOption = (value: string) => (event: MouseEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (picked !== value) onPick(value);
    else if (!required) onPick(undefined);
  };
  // Other is chosen by its text: a tap chooses it while it holds some, and goes to type it otherwise.
  const tapOther = (event: MouseEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (otherChosen) {
      if (!required) onChooseOther?.(false);
    } else if (typed) {
      onChooseOther?.(true);
    } else {
      inputRef.current?.focus();
    }
  };
  return (
    <FieldSet data-invalid={Boolean(error)} className="gap-2">
      <FieldLegend id={legendId} variant="label" className="mb-0">{label}</FieldLegend>
      {description && <FieldDescription>{description}</FieldDescription>}
      <RadioGroup
        aria-labelledby={legendId}
        aria-required={required || undefined}
        className="gap-2"
        disabled={disabled}
        value={otherChosen ? OTHER : picked ?? null}
        onValueChange={(next) => {
          if (next !== OTHER) onPick(next as string);
          else if (typed) onChooseOther?.(true);
        }}
      >
        {options.map((option, index) => {
          const optionId = `${id}-${index}`;
          return (
            <Field key={option.value} orientation="horizontal">
              <RadioGroupItem id={optionId} value={option.value} aria-invalid={Boolean(error)} onClick={tapOption(option.value)} />
              <OptionLabel id={optionId} option={option} onClick={tapOption(option.value)} />
            </Field>
          );
        })}
        {other && (
          <Field orientation="horizontal">
            <RadioGroupItem value={OTHER} aria-labelledby={otherLabelId} aria-invalid={Boolean(error)} onClick={tapOther} />
            {/* Its title names its text too, and a tap on it goes to type. */}
            <FieldLabel id={otherLabelId} htmlFor={other.id} className="font-normal">{other.label}</FieldLabel>
          </Field>
        )}
      </RadioGroup>
      {companion && (
        <CompanionText
          row={companion}
          named={Boolean(other)}
          unsent={Boolean(other) && !otherChosen && typed}
          disabled={disabled}
          inputRef={inputRef}
          onFocus={() => {
            if (other && !otherChosen && typed) onChooseOther?.(true);
          }}
        />
      )}
      <FieldError>{error}</FieldError>
    </FieldSet>
  );
}

/**
 * A multi-select as a list of its options' checkboxes. Claude's Other is one more of them,
 * checked while it holds text, which is how it's picked; a tap on its box goes to type it.
 * Codex's note sits under the options.
 */
function MultiChoice({
  id,
  label,
  description,
  options,
  picked,
  disabled,
  error,
  onPick,
  companion,
}: {
  id: string;
  label: string;
  description?: string;
  options: ChoiceOption[];
  picked: string[];
  disabled: boolean;
  error?: string;
  onPick(values: string[]): void;
  companion?: CompanionRow;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const otherLabelId = `${id}-other`;
  const other = companion?.kind === 'replaces' ? companion : undefined;
  return (
    <FieldSet data-invalid={Boolean(error)} className="gap-2">
      <FieldLegend variant="label" className="mb-0">{label}</FieldLegend>
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldGroup data-slot="checkbox-group" className="gap-2">
        {options.map((option, index) => {
          const optionId = `${id}-${index}`;
          return (
            <Field key={option.value} orientation="horizontal">
              <Checkbox
                aria-invalid={Boolean(error)}
                id={optionId}
                disabled={disabled}
                checked={picked.includes(option.value)}
                // The picks go in the options' order, as the TUI sends them.
                onCheckedChange={(checked) => onPick(options
                  .filter((each) => (each.value === option.value ? checked : picked.includes(each.value)))
                  .map(({ value }) => value))}
              />
              <OptionLabel id={optionId} option={option} />
            </Field>
          );
        })}
        {other && (
          <Field orientation="horizontal">
            <Checkbox
              readOnly
              aria-labelledby={otherLabelId}
              disabled={disabled}
              checked={typedText(other.text) !== undefined}
              onClick={(event) => {
                event.preventDefault();
                inputRef.current?.focus();
              }}
            />
            <FieldLabel id={otherLabelId} htmlFor={other.id} className="font-normal">{other.label}</FieldLabel>
          </Field>
        )}
        {companion && <CompanionText row={companion} named={Boolean(other)} disabled={disabled} inputRef={inputRef} />}
      </FieldGroup>
      <FieldError>{error}</FieldError>
    </FieldSet>
  );
}

/** How a request stopped waiting, under its card. */
function Outcome({ entry }: { entry: TranscriptElicitation }) {
  if (entry.status === 'pending') return null;
  const text = entry.status === 'completed'
    ? 'The agent finished the step you opened in the browser'
    : entry.status === 'answered'
      ? elicitationAnswerText(entry.response, Boolean(urlRequest(entry.request)))
      : requestEndText[entry.status];
  return <p className="text-[0.6875rem] text-muted-foreground" data-slot="elicitation-outcome">{text}</p>;
}

const without = <T,>(record: Partial<Record<string, T>>, names: (string | undefined)[]) => {
  if (!names.some((name) => name !== undefined && name in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name))) as Partial<Record<string, T>>;
};

/**
 * A form, one field under another. A choice's free-text companion is its last row rather than a
 * field of its own, and the answer is the fields the agent asked for, filled as its adapter reads
 * them (`elicitation-conventions.ts`).
 */
function ElicitationForm({
  entry,
  form,
  onRespond,
}: {
  entry: TranscriptElicitation;
  form: FormRequest;
  onRespond(requestId: string, response: CreateElicitationResponse): void;
}) {
  const schema = form.requestedSchema;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const companions = useMemo(() => formCompanions(schema), [schema]);
  const companionKeys = new Set([...companions.values()].map(({ key }) => key));
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(
    Object.entries(properties).flatMap(([name, property]) => {
      const value = (property as { default?: unknown }).default;
      return value == null ? [] : [[name, value as ElicitationContentValue]];
    }),
  ));
  // The single-selects whose Claude Other is the pick, in place of an option.
  const [otherChosen, setOtherChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<FormErrors>({});
  const waiting = entry.status === 'pending';

  const forget = (...names: (string | undefined)[]) => setErrors((current) => without(current, names) as FormErrors);
  const setValue = (name: string, value: ElicitationContentValue | undefined) => setValues((current) => (
    value === undefined ? without(current, [name]) : { ...current, [name]: value }
  ));
  const setChosen = (name: string, chosen: boolean) => setOtherChosen((current) => {
    if (current.has(name) === chosen) return current;
    const next = new Set(current);
    if (chosen) next.add(name);
    else next.delete(name);
    return next;
  });
  const pick = (name: string, value: string | undefined) => {
    setValue(name, value);
    setChosen(name, false);
    forget(name, companions.get(name)?.key);
  };
  const chooseOther = (name: string, chosen: boolean) => {
    setChosen(name, chosen);
    if (chosen) setValue(name, undefined);
    forget(name, companions.get(name)?.key);
  };
  const typeCompanion = (choice: string, companion: Companion, text: string) => {
    setValue(companion.key, text);
    // Claude's Other in a single-select is the pick while it holds text.
    if (companion.kind === 'replaces' && isSingleChoice(properties[choice])) {
      if (typedText(text) !== undefined) chooseOther(choice, true);
      else setChosen(choice, false);
    }
    forget(choice, companion.key);
  };
  const change = (name: string, value: ElicitationContentValue | undefined) => {
    setValue(name, value);
    forget(name);
  };

  return (
    <form
      aria-label={form.message}
      className="grid gap-3 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const content = formAnswer(schema, companions, values, otherChosen);
        const nextErrors = validateForm(form, companions, content);
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        onRespond(entry.requestId, { action: 'accept', content });
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{form.message}</span>
        {waiting && <Badge className="ml-auto" variant="outline">Input requested</Badge>}
      </div>
      <fieldset disabled={!waiting} className="contents">
        <FieldGroup className="gap-4">
          {Object.entries(properties).map(([name, property]) => {
            if (companionKeys.has(name)) return null;
            const { label, description } = fieldDetails(name, property);
            const value = values[name];
            const companion = companions.get(name);
            const row: CompanionRow | undefined = companion && {
              ...companion,
              id: `elicitation-${companion.key}`,
              label: fieldDetails(companion.key, properties[companion.key]).label,
              text: typeof values[companion.key] === 'string' ? values[companion.key] as string : '',
              error: errors[companion.key],
              onText: (text) => typeCompanion(name, companion, text),
            };
            const choice = { id: `elicitation-${name}`, label, description, disabled: !waiting, error: errors[name] };
            if (isSingleChoice(property)) {
              return (
                <SingleChoice
                  key={name}
                  {...choice}
                  options={enumOptions(property)}
                  picked={typeof value === 'string' ? value : undefined}
                  required={required.has(name)}
                  onPick={(next) => pick(name, next)}
                  companion={row}
                  otherChosen={otherChosen.has(name)}
                  onChooseOther={(chosen) => chooseOther(name, chosen)}
                />
              );
            }
            if (property.type === 'boolean') {
              return (
                <SingleChoice
                  key={name}
                  {...choice}
                  options={YES_NO}
                  picked={typeof value === 'boolean' ? String(value) : undefined}
                  required={required.has(name)}
                  onPick={(next) => change(name, next === undefined ? undefined : next === 'true')}
                />
              );
            }
            if (property.type === 'array') {
              return (
                <MultiChoice
                  key={name}
                  {...choice}
                  options={multiOptions(property as MultiSelectPropertySchema)}
                  picked={Array.isArray(value) ? value : []}
                  onPick={(next) => change(name, next)}
                  companion={row}
                />
              );
            }
            return (
              <FormField
                key={name}
                name={name}
                schema={property}
                value={value}
                error={errors[name]}
                onChange={(next) => change(name, next)}
              />
            );
          })}
        </FieldGroup>
      </fieldset>
      {waiting
        ? (
          <div className="flex justify-end gap-1.5 border-t pt-2">
            <Button type="button" variant="ghost" onClick={() => onRespond(entry.requestId, { action: 'cancel' })}>
              Cancel
            </Button>
            <Button type="button" variant="outline" onClick={() => onRespond(entry.requestId, { action: 'decline' })}>
              Decline
            </Button>
            <Button type="submit">Submit</Button>
          </div>
        )
        : <Outcome entry={entry} />}
    </form>
  );
}

/**
 * A page the agent wants opened, such as a sign-in. The card shows the whole URL and its host,
 * with what to beware of; it opens only when the person says so, and the app never fetches it.
 */
function UrlElicitation({
  entry,
  url,
  onRespond,
  onOpenUrl,
}: {
  entry: TranscriptElicitation;
  url: UrlRequest;
  onRespond(requestId: string, response: CreateElicitationResponse): void;
  onOpenUrl(url: string): void;
}) {
  const { host, warnings } = urlCheck(url.url);
  return (
    <Alert>
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.75} />
      <AlertTitle>{url.message}</AlertTitle>
      <AlertDescription className="grid gap-1.5">
        <span>{host ? <>It wants to open a page on <strong className="text-foreground">{host}</strong> in your browser:</> : 'It wants to open:'}</span>
        <code className="break-all text-[0.6875rem]" data-slot="elicitation-url">{url.url}</code>
        {warnings.length > 0 && (
          <ul className="grid gap-0.5 text-warning">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}
        {entry.status === 'pending'
          ? (
            <div className="flex flex-wrap justify-end gap-1.5 pt-1">
              <Button size="sm" variant="ghost" onClick={() => onRespond(entry.requestId, { action: 'cancel' })}>
                Cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onRespond(entry.requestId, { action: 'decline' })}>
                Decline
              </Button>
              {host && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onOpenUrl(url.url);
                    onRespond(entry.requestId, { action: 'accept' });
                  }}
                >
                  Open in browser
                  <HugeiconsIcon data-icon="inline-end" icon={ArrowUpRight01Icon} strokeWidth={1.75} />
                </Button>
              )}
            </div>
          )
          : <Outcome entry={entry} />}
      </AlertDescription>
    </Alert>
  );
}

/** Opens a page in the system browser: Capacitor hands a new window's URL to iOS. */
const openInBrowser = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

export function ElicitationView({
  entry,
  onRespond,
  onOpenUrl = openInBrowser,
}: {
  entry: TranscriptElicitation;
  onRespond(requestId: string, response: CreateElicitationResponse): void;
  onOpenUrl?(url: string): void;
}) {
  const form = formRequest(entry.request);
  if (form) return <ElicitationForm entry={entry} form={form} onRespond={onRespond} />;
  const url = urlRequest(entry.request);
  if (url) return <UrlElicitation entry={entry} url={url} onRespond={onRespond} onOpenUrl={onOpenUrl} />;
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
        {entry.status === 'pending'
          ? (
            <Button
              className="mt-2"
              size="sm"
              variant="ghost"
              onClick={() => onRespond(entry.requestId, { action: 'cancel' })}
            >
              Dismiss
            </Button>
          )
          : <Outcome entry={entry} />}
      </AlertDescription>
    </Alert>
  );
}
