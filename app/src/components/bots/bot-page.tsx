// A Bot's page (WVE-178), from its name atop its Session: what it is, what can be changed of it
// (`bots/update`), its schedules and the wake-ups it asked for, its earlier threads to read, the
// threads it started elsewhere, and starting a new thread or removing it. There's no adding a
// schedule here: a Bot manages its own, through its tools, when the person asks it to.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { BubbleChatIcon, Clock01Icon, Folder01Icon, LaptopIcon } from '@hugeicons/core-free-icons';
import type { AppController, BotChange, BotSummary, ScheduleAction, ScheduleSummary, ThreadSummary } from '@/app/app-controller';
import { threadKey } from '@/app/app-controller';
import { BotStateDot } from '@/components/bots/bot-list';
import { ThreadReader } from '@/components/bots/thread-reader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { PermissionPolicy } from '@/host/protocol';
import { botRowState, botStateLabel, durationLabel, earlierThreads, groupStarted, startedByBot } from '@/session/bots';

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const HOUR = 3_600_000;

/** What a permission policy does, as the person reads it. */
export function policyLabel(policy: PermissionPolicy): string {
  const approved = policy.approve ?? [];
  const rest = policy.otherwise === 'reject' ? 'rejects the rest' : 'asks you about the rest';
  if (approved.length === 0) return policy.otherwise === 'reject' ? 'Rejects everything it would ask about.' : 'Asks you before anything it would ask about.';
  const kinds = approved.map((kind) => kind.replace('_', ' '));
  const listed = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
  return `Approves ${listed} without asking, and ${rest}.`;
}

const dayLabel = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dateLabel = (at: number) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A heading and what's under it, on the page. */
function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className='grid gap-2 border-t border-border px-4 py-3'>
      <div className='flex items-center gap-2'>
        <h3 className='text-xs font-semibold'>{title}</h3>
        <span className='ml-auto'>{action}</span>
      </div>
      {children}
    </section>
  );
}

/** One of its facts: a name and what it is. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className='grid grid-cols-[6rem_1fr] items-baseline gap-2'>
      <dt className='text-muted-foreground'>{name}</dt>
      <dd className='min-w-0 break-words'>{children}</dd>
    </div>
  );
}

const row = 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted outline-none';

/** What it is, and what can be changed of it: its name, mode, daily new thread and how long a request may wait. */
function Settings({ controller, bot }: { controller: AppController; bot: BotSummary }) {
  const { model, actions } = controller;
  const [name, setName] = useState(bot.name);
  const [mode, setMode] = useState(bot.mode ?? '');
  const [daily, setDaily] = useState(bot.newThreadAt ?? '');
  const [zone, setZone] = useState(bot.zone);
  const [hours, setHours] = useState(String(bot.pauseAfter / HOUR));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // What the Dispatcher says it is now, as another device or the Bot changes it.
  useEffect(() => {
    setName(bot.name);
    setMode(bot.mode ?? '');
    setDaily(bot.newThreadAt ?? '');
    setZone(bot.zone);
    setHours(String(bot.pauseAfter / HOUR));
  }, [bot.id, bot.updatedAt]);
  // The modes its agent offers, as its current thread lists them, when that's open here.
  const thread = bot.thread ? model.open?.[threadKey(bot.hostId, bot.thread)] : undefined;
  const modes = thread?.transcript.availableModes ?? [];
  const pauseAfter = Math.round(Number(hours) * HOUR);
  const change: BotChange = {
    ...(name.trim() && name.trim() !== bot.name ? { name: name.trim() } : {}),
    ...(mode.trim() !== (bot.mode ?? '') ? { mode: mode.trim() || null } : {}),
    ...(daily !== (bot.newThreadAt ?? '') ? { newThreadAt: daily || null } : {}),
    ...(zone.trim() && zone.trim() !== bot.zone ? { zone: zone.trim() } : {}),
    ...(Number.isFinite(pauseAfter) && pauseAfter > 0 && pauseAfter !== bot.pauseAfter ? { pauseAfter } : {}),
  };
  const changed = Object.keys(change).length > 0;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!actions.updateBot || !changed) return;
    setError(undefined);
    setSaving(true);
    setSaved(false);
    try {
      await actions.updateBot(bot.id, change);
      setSaved(true);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSaving(false);
    }
  };
  const field = 'grid gap-1.5';
  return (
    <form aria-label='Settings' className='grid gap-3' onSubmit={save}>
      <div className={field}>
        <Label htmlFor='bot-name'>Name</Label>
        <Input id='bot-name' autoComplete='off' maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className={field}>
        <Label htmlFor='bot-mode'>Mode of new threads</Label>
        {modes.length > 0
          ? (
            <select id='bot-mode' value={mode} onChange={(event) => setMode(event.target.value)}
              className='h-7 w-full min-w-0 rounded-md border border-input bg-input-background px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed'>
              <option value=''>The agent's own</option>
              {modes.map(({ id, name: modeName }) => <option key={id} value={id}>{modeName}</option>)}
              {mode && !modes.some(({ id }) => id === mode) && <option value={mode}>{mode}</option>}
            </select>
          )
          : <Input id='bot-mode' autoComplete='off' autoCapitalize='off' placeholder="The agent's own" value={mode} onChange={(event) => setMode(event.target.value)} />}
      </div>
      <div className='grid grid-cols-[1fr_1fr] gap-2'>
        <div className={field}>
          <Label htmlFor='bot-daily'>New thread daily at</Label>
          <div className='flex gap-1'>
            <Input id='bot-daily' type='time' value={daily} onChange={(event) => setDaily(event.target.value)} />
            {daily && <Button type='button' size='sm' variant='ghost' onClick={() => setDaily('')}>Clear</Button>}
          </div>
        </div>
        <div className={field}>
          <Label htmlFor='bot-zone'>Time zone</Label>
          <Input id='bot-zone' autoComplete='off' autoCapitalize='off' value={zone} onChange={(event) => setZone(event.target.value)} />
        </div>
      </div>
      <p className='-mt-1.5 text-[0.6875rem] text-muted-foreground'>
        {daily ? `Each day at ${daily}, once its thread has had a turn, it saves its notes and a new thread takes over.` : 'No new thread daily: one starts when you ask for it.'}
      </p>
      <div className={field}>
        <Label htmlFor='bot-pause'>Pause its schedules after a request waits (hours)</Label>
        <Input id='bot-pause' type='number' inputMode='decimal' min={0.25} step={0.25} value={hours} onChange={(event) => setHours(event.target.value)} />
        <p className='text-[0.6875rem] text-muted-foreground'>Now {durationLabel(bot.pauseAfter)}.</p>
      </div>
      <div className={field}>
        <span className='text-xs font-medium'>Permissions</span>
        <p className='text-xs text-muted-foreground'>{policyLabel(bot.policy)} Changed with <code>weave bots</code> for now.</p>
      </div>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      <div className='flex items-center gap-2'>
        <Button type='submit' size='sm' disabled={!changed || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {saved && !changed && <span role='status' className='text-[0.6875rem] text-muted-foreground'>Saved. New threads start this way.</span>}
      </div>
    </form>
  );
}

/** When a schedule runs, as people read it. */
const whenLabel = (schedule: ScheduleSummary) => {
  if (schedule.paused) return 'paused';
  if (schedule.next) return schedule.next;
  if (schedule.at !== undefined) return `${schedule.at > Date.now() ? 'at' : 'was due'} ${dateLabel(schedule.at)}`;
  return schedule.cron || 'done';
};

/** Its schedules and wake-ups: each paused or resumed, run now, or removed. */
function Schedules({ controller, bot }: { controller: AppController; bot: BotSummary }) {
  const { actions } = controller;
  const [schedules, setSchedules] = useState<ScheduleSummary[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState<ScheduleSummary>();
  const list = async () => {
    if (!actions.botSchedules) return;
    try {
      setSchedules(await actions.botSchedules(bot.id));
    } catch (cause) {
      setError(describe(cause));
    }
  };
  useEffect(() => {
    setSchedules(undefined);
    setError(undefined);
    void list();
  }, [bot.id]);
  const act = async (schedule: ScheduleSummary, action: ScheduleAction) => {
    if (!actions.changeSchedule) return;
    setError(undefined);
    setBusy(schedule.id);
    try {
      await actions.changeSchedule(schedule.id, action);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(undefined);
      await list();
    }
  };
  return (
    <>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      {schedules === undefined && !error && <p className='text-muted-foreground'><Spinner className='mr-1.5 inline size-3' />Listing them…</p>}
      {schedules?.length === 0 && (
        <p className='text-muted-foreground'>None. Ask {bot.name} to remind itself or check something on a schedule, and it sets one up.</p>
      )}
      <ul aria-label='Schedules and wake-ups' className='grid gap-1.5'>
        {schedules?.map((schedule) => (
          <li key={schedule.id} className='grid gap-1 rounded-md border border-border p-2'>
            <div className='flex min-w-0 items-center gap-1.5'>
              <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
              <span className='min-w-0 truncate font-medium'>{schedule.wakeUp ? 'Wake-up' : schedule.name}</span>
              <span className={cn('ml-auto shrink-0 text-[0.6875rem]', schedule.paused ? 'text-warning' : 'text-muted-foreground')}>{whenLabel(schedule)}</span>
            </div>
            {schedule.prompt && <p className='line-clamp-2 text-[0.6875rem] text-muted-foreground'>{schedule.prompt}</p>}
            {schedule.paused && <p className='text-[0.6875rem] text-muted-foreground'>Paused: {schedule.paused}</p>}
            {schedule.last?.why && <p className='text-[0.6875rem] text-muted-foreground'>Last time: {schedule.last.why}</p>}
            <div className='flex flex-wrap gap-1'>
              {schedule.paused
                ? <Button size='xs' variant='outline' disabled={busy === schedule.id} aria-label={`Resume ${schedule.name}`} onClick={() => void act(schedule, 'resume')}>Resume</Button>
                : <Button size='xs' variant='outline' disabled={busy === schedule.id} aria-label={`Pause ${schedule.name}`} onClick={() => void act(schedule, 'pause')}>Pause</Button>}
              <Button size='xs' variant='outline' disabled={busy === schedule.id} aria-label={`Run ${schedule.name} now`} onClick={() => void act(schedule, 'run')}>Run now</Button>
              <Button size='xs' variant='ghost' className='text-destructive' disabled={busy === schedule.id} aria-label={`Remove ${schedule.name}`} onClick={() => setRemoving(schedule)}>Remove</Button>
            </div>
          </li>
        ))}
      </ul>
      <AlertDialog open={removing !== undefined} onOpenChange={(next) => { if (!next) setRemoving(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.wakeUp ? 'this wake-up' : removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>It won't prompt {bot.name} again. A turn it already started runs on.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => {
              const schedule = removing;
              setRemoving(undefined);
              if (schedule) void act(schedule, 'remove');
            }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A thread's row: its title, and what it's doing or when it was. */
function ThreadRow({ thread, detail, onOpen }: { thread?: ThreadSummary; detail: string; onOpen(): void }) {
  return (
    <button type='button' className={row} onClick={onOpen}>
      <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
      <span className='min-w-0 flex-1 truncate'>{thread?.title || 'Untitled thread'}</span>
      <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{detail}</span>
    </button>
  );
}

export function BotPage({ controller, bot, open, onOpenChange, phone = false, onBringIn, onRemoved }: {
  controller: AppController;
  bot?: BotSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
  phone?: boolean;
  /** Gives a thread the Bot started elsewhere a Block in its directory's Session, and opens it. */
  onBringIn(thread: ThreadSummary): void;
  /** The Bot was removed. */
  onRemoved(bot: BotSummary): void;
}) {
  const { model, actions } = controller;
  const [reading, setReading] = useState<{ key: string; title: string; description: string }>();
  const [confirm, setConfirm] = useState<'newThread' | 'remove'>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const started = useMemo(() => bot ? groupStarted(startedByBot(bot, model.threads), model.projects, model.hosts) : undefined, [bot, model.threads, model.projects, model.hosts]);
  if (!bot) return null;
  const state = botRowState(bot, model.unread);
  const agent = model.agents[bot.hostId]?.find(({ id }) => id === bot.agentId)?.name ?? bot.agentId;
  const earlier = earlierThreads(bot);
  const listed = (threadId: string) => model.threads.find(({ key }) => key === threadKey(bot.hostId, threadId));
  const run = async (what: () => Promise<void> | undefined) => {
    setError(undefined);
    try {
      await what();
    } catch (cause) {
      setError(describe(cause));
    }
  };
  const startedCount = (started?.projects.reduce((sum, { threads }) => sum + threads.length, 0) ?? 0) + (started?.hosts.reduce((sum, { threads }) => sum + threads.length, 0) ?? 0);
  const activity = (thread: ThreadSummary) => thread.state === 'closed' ? 'closed' : thread.activity === 'waiting' ? 'waiting on you' : thread.activity === 'running' ? 'running' : thread.agentName;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        {/* Nothing typed into until the person picks a field: a phone's keyboard stays down. */}
        <SheetContent side={phone ? 'bottom' : 'right'} data-slot='bot-page' initialFocus={false}
          className={cn('gap-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]', phone ? 'max-h-[92dvh] rounded-t-xl' : 'w-full sm:max-w-md')}>
          <SheetHeader className='pb-3'>
            <SheetTitle className='flex items-center gap-2 pr-8 text-base'>
              {bot.name}
              <BotStateDot state={state} />
            </SheetTitle>
            <SheetDescription>{bot.startingThread ? 'Starting a new thread.' : `A Bot, ${botStateLabel[state]}.`}</SheetDescription>
          </SheetHeader>
          <div className='grid gap-2 px-4 pb-3'>
            {bot.paused && (
              <Alert className='border-warning/40'>
                <AlertDescription>Its schedules are paused: {bot.paused}. They go on once nothing in its thread waits for you.</AlertDescription>
              </Alert>
            )}
            {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
            <dl className='grid gap-1.5'>
              <Fact name='Agent'>{agent}</Fact>
              <Fact name='Host'>
                <span className='inline-flex items-center gap-1'>
                  <HugeiconsIcon icon={LaptopIcon} strokeWidth={2} className='size-3.5 text-icon-muted' aria-hidden />
                  {bot.hostName}
                  <span className={cn('text-[0.6875rem]', bot.connected ? 'text-muted-foreground' : 'text-warning')}>· {bot.connected ? 'connected' : 'away'}</span>
                </span>
              </Fact>
              <Fact name='Home'>
                <span className='inline-flex min-w-0 items-center gap-1' title={bot.home}>
                  <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
                  <span className='truncate font-mono text-[0.6875rem]'>{bot.home}</span>
                </span>
              </Fact>
              {bot.createdBy && <Fact name='Made by'>{bot.createdByName ?? 'a Bot that has since been removed'}</Fact>}
              <Fact name='Since'>{dateLabel(bot.createdAt)}</Fact>
            </dl>
          </div>
          <Part title='Settings'>
            <Settings controller={controller} bot={bot} />
          </Part>
          <Part title='Schedules and wake-ups'>
            <Schedules controller={controller} bot={bot} />
          </Part>
          <Part title='Earlier threads'>
            {earlier.length === 0
              ? <p className='text-muted-foreground'>{bot.thread ? 'None yet: its first thread is still its current one.' : 'None yet.'}</p>
              : (
                <div className='grid gap-0.5'>
                  {earlier.map(({ threadId, startedAt, endedAt }) => {
                    const thread = listed(threadId);
                    return (
                      <ThreadRow key={threadId} thread={thread} detail={dayLabel(startedAt) === dayLabel(endedAt) ? dayLabel(endedAt) : `${dayLabel(startedAt)} – ${dayLabel(endedAt)}`}
                        onOpen={() => setReading({
                          key: threadKey(bot.hostId, threadId),
                          title: thread?.title || `${bot.name}'s thread of ${dateLabel(startedAt)}`,
                          description: `${bot.name}'s thread from ${dateLabel(startedAt)} to ${dateLabel(endedAt)}, to read: a newer one took over from it.`,
                        })} />
                    );
                  })}
                </div>
              )}
          </Part>
          <Part title='Started elsewhere'>
            {startedCount === 0 && <p className='text-muted-foreground'>Threads {bot.name} starts in your Projects show here.</p>}
            {started?.projects.map(({ project, threads }) => (
              <div key={project.id} role='group' aria-label={project.name} className='grid gap-0.5'>
                <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>{project.name}</p>
                {threads.map((thread) => <ThreadRow key={thread.key} thread={thread} detail={activity(thread)} onOpen={() => onBringIn(thread)} />)}
              </div>
            ))}
            {started?.hosts.map(({ hostId, host, threads }) => (
              <div key={hostId} role='group' aria-label={host?.name ?? hostId} className='grid gap-0.5'>
                <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>{host?.name ?? 'Another Host'}</p>
                {threads.map((thread) => <ThreadRow key={thread.key} thread={thread} detail={activity(thread)} onOpen={() => onBringIn(thread)} />)}
              </div>
            ))}
          </Part>
          <div className='flex flex-wrap gap-2 border-t border-border px-4 py-3'>
            <Button size='sm' variant='outline' disabled={!bot.thread || bot.startingThread || !actions.newBotThread} onClick={() => setConfirm('newThread')}>New thread</Button>
            <Button size='sm' variant='destructive' disabled={!actions.removeBot} onClick={() => setConfirm('remove')}>Remove</Button>
          </div>
        </SheetContent>
      </Sheet>
      <ThreadReader controller={controller} threadKey={reading?.key} title={reading?.title ?? ''} description={reading?.description} onClose={() => setReading(undefined)} />
      <AlertDialog open={confirm !== undefined} onOpenChange={(next) => { if (!next) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'remove' ? `Remove ${bot.name}?` : `Start a new thread for ${bot.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'remove'
                ? `The Dispatcher forgets ${bot.name}, its schedules and its wake-ups. Its home and its threads stay on ${bot.hostName}, and its Session is listed under ${bot.hostName} like any other.`
                : `Once its thread is idle, ${bot.name} saves what's worth keeping to its home and notes the thread, then a new thread takes over. Messages sent meanwhile wait for the new one.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{confirm === 'remove' ? 'Keep it' : 'Not now'}</AlertDialogCancel>
            <AlertDialogAction variant={confirm === 'remove' ? 'destructive' : 'default'} onClick={() => {
              const what = confirm;
              setConfirm(undefined);
              if (what === 'remove') {
                void run(async () => {
                  await actions.removeBot?.(bot.id);
                  onRemoved(bot);
                });
              } else {
                void run(() => actions.newBotThread?.(bot.id));
              }
            }}>{confirm === 'remove' ? 'Remove' : 'Start a new thread'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
