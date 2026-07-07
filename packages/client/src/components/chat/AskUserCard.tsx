import { Check, Loader2, MessageCircleQuestion, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import type { AskUserAnswer, AskUserPart, AskUserResume } from './ask-user';

type QuestionDraft = {
  selectedOptionId?: string;
  customAnswer: string;
};

type AskUserCardProps = {
  part: AskUserPart;
  disabled?: boolean;
  placement?: 'inline' | 'dock' | 'user';
  readOnly?: boolean;
  resume?: AskUserResume;
  onRespond?: (part: AskUserPart, resume: AskUserResume) => Promise<void>;
};

const initialDrafts = (part: AskUserPart): Record<string, QuestionDraft> =>
  Object.fromEntries(part.questions.map(question => [question.id, { customAnswer: '' }]));

const trim = (value: string) => value.trim();

export const AskUserCard = ({
  part,
  disabled = false,
  placement = 'inline',
  readOnly = false,
  resume,
  onRespond,
}: AskUserCardProps) => {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() => initialDrafts(part));
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedResume, setSubmittedResume] = useState<AskUserResume | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isReadOnly = readOnly || part.status === 'submitted';
  const isAnswered = isReadOnly || submittedResume !== null;
  const isDisabled = disabled || isSubmitting || isAnswered;
  const safeQuestionIndex = Math.min(activeQuestionIndex, Math.max(0, part.questions.length - 1));
  const currentQuestion = part.questions[safeQuestionIndex];
  const isUserPlacement = placement === 'user';
  const cardClassName = placement === 'dock'
    ? 'mx-auto mb-3 w-full max-w-[var(--weave-chat-content-max-width)] rounded-lg border border-border bg-card/85 p-3 text-sm text-card-foreground shadow-sm'
    : placement === 'user'
    ? 'chat-message-bubble min-w-0 w-full max-w-full rounded-lg border border-mauve bg-mauve p-3 text-sm text-primary-foreground shadow-sm sm:max-w-[78%]'
    : 'my-3 -mx-4 w-[calc(100%+2rem)] max-w-none rounded-lg border border-border bg-card/85 p-3 text-sm text-card-foreground shadow-sm sm:-mx-[38px] sm:w-[calc(100%+76px)]';

  const answers = useMemo(() => {
    const next: AskUserAnswer[] = [];

    for (const question of part.questions) {
      const draft = drafts[question.id] ?? { customAnswer: '' };
      const customAnswer = trim(draft.customAnswer);
      if (customAnswer) {
        next.push({
          id: question.id,
          customAnswer,
          finalAnswer: customAnswer,
        });
        continue;
      }

      const selectedOption = question.options.find(option => option.id === draft.selectedOptionId);
      if (!selectedOption) return null;
      next.push({
        id: question.id,
        selectedOptionId: selectedOption.id,
        finalAnswer: selectedOption.label,
      });
    }

    return next;
  }, [drafts, part.questions]);

  const answeredQuestionIds = useMemo(() => {
    const answered = new Set<string>();
    for (const question of part.questions) {
      const draft = drafts[question.id] ?? { customAnswer: '' };
      if (trim(draft.customAnswer)) {
        answered.add(question.id);
        continue;
      }
      if (question.options.some(option => option.id === draft.selectedOptionId)) answered.add(question.id);
    }
    return answered;
  }, [drafts, part.questions]);

  const currentQuestionAnswered = currentQuestion ? answeredQuestionIds.has(currentQuestion.id) : false;
  const submittedAnswerByQuestionId = useMemo(() => {
    const answerMap = new Map<string, AskUserAnswer>();
    if (resume?.action !== 'submit') return answerMap;
    for (const answer of resume.answers) answerMap.set(answer.id, answer);
    return answerMap;
  }, [resume]);

  const getSubmittedAnswerLabel = (questionId: string) => {
    const answer = submittedAnswerByQuestionId.get(questionId);
    if (!answer) return undefined;
    const question = part.questions.find(item => item.id === questionId);
    const option = question?.options.find(item => item.id === answer.selectedOptionId);
    return option?.label ?? answer.finalAnswer;
  };

  const setSelectedOption = (questionId: string, selectedOptionId: string) => {
    setError(null);
    setDrafts(previous => ({
      ...previous,
      [questionId]: {
        selectedOptionId,
        customAnswer: '',
      },
    }));
  };

  const setCustomAnswer = (questionId: string, customAnswer: string) => {
    setError(null);
    setDrafts(previous => ({
      ...previous,
      [questionId]: {
        selectedOptionId: customAnswer.trim() ? undefined : previous[questionId]?.selectedOptionId,
        customAnswer,
      },
    }));
  };

  const respond = async (resume: AskUserResume) => {
    if (!onRespond) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onRespond(part, resume);
      setSubmittedResume(resume);
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : String(responseError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submit = () => {
    if (!answers) return;
    void respond({ action: 'submit', answers });
  };

  const cancel = () => {
    void respond({ action: 'cancel', reason: 'cancelled_by_user' });
  };

  if (placement === 'dock' && submittedResume !== null) return null;

  const goToQuestion = (index: number) => {
    setActiveQuestionIndex(Math.max(0, Math.min(index, part.questions.length - 1)));
  };

  const goToNextQuestion = () => {
    goToQuestion(safeQuestionIndex + 1);
  };

  const goToPreviousQuestion = () => {
    goToQuestion(safeQuestionIndex - 1);
  };

  const renderQuestion = () => {
    if (!currentQuestion) return null;

    const draft = drafts[currentQuestion.id] ?? { customAnswer: '' };
    const customActive = trim(draft.customAnswer).length > 0;

    return (
      <div>
        {currentQuestion.header ? (
          <div className="mb-1 text-xs font-medium text-muted-foreground">{currentQuestion.header}</div>
        ) : null}
        <div className="mb-2 font-medium leading-snug text-foreground">{currentQuestion.question}</div>
        <div className="grid gap-1.5">
          {currentQuestion.options.map(option => {
            const selected = !customActive && draft.selectedOptionId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                disabled={isDisabled}
                aria-pressed={selected}
                onClick={() => setSelectedOption(currentQuestion.id, option.id)}
                className={cn(
                  'flex min-h-11 w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                  selected
                    ? 'border-primary/70 bg-primary/10 text-foreground'
                    : 'border-border bg-background/70 hover:border-primary/40 hover:bg-accent/50',
                  isDisabled && 'cursor-default opacity-70 hover:border-border hover:bg-background/70',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                  )}
                >
                  {selected ? <Check size={11} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block break-words font-medium leading-snug">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block break-words text-xs leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <textarea
          value={draft.customAnswer}
          disabled={isDisabled}
          rows={2}
          onChange={event => setCustomAnswer(currentQuestion.id, event.target.value)}
          placeholder="Other"
          className={cn(
            'mt-2 min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm leading-snug text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25',
            isDisabled && 'opacity-70',
          )}
        />
      </div>
    );
  };

  const renderReadOnlyQuestions = () => (
    <div className="grid gap-2">
      {part.questions.map((question, index) => {
        const answer = getSubmittedAnswerLabel(question.id);
        return (
          <div
            key={question.id}
            className={cn(
              'flex min-w-0 gap-2 rounded-md border px-2.5 py-2',
              isUserPlacement ? 'border-primary-foreground/20 bg-background/90 text-foreground' : 'border-border bg-background/50',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                isUserPlacement ? 'bg-primary/20 text-foreground' : 'bg-success/15 text-success',
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              {question.header ? (
                <span className={cn('block text-xs font-medium', isUserPlacement ? 'text-muted-foreground' : 'text-muted-foreground')}>
                  {question.header}
                </span>
              ) : null}
              <span className={cn('block break-words font-medium leading-snug', isUserPlacement ? 'text-foreground' : 'text-foreground')}>
                {question.question}
              </span>
              {answer ? (
                <span className={cn('mt-1 block break-words text-right text-sm font-semibold leading-snug', isUserPlacement ? 'text-foreground' : 'text-foreground')}>
                  {answer}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className={cardClassName}>
      <div
        className={cn(
          'mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-normal',
          isUserPlacement ? 'text-primary-foreground/70' : 'text-muted-foreground',
        )}
      >
        <MessageCircleQuestion size={14} className="shrink-0" />
        <span>Questions</span>
      </div>

      {isReadOnly ? null : (
        <div className="mb-4 flex min-w-0 items-center">
          {part.questions.map((question, index) => {
            const active = index === safeQuestionIndex;
            const completed = answeredQuestionIds.has(question.id);
            return (
              <div key={question.id} className={cn('flex min-w-0 items-center', index < part.questions.length - 1 && 'flex-1')}>
                <button
                  type="button"
                  disabled={isDisabled}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Question ${index + 1}`}
                  onClick={() => goToQuestion(index)}
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : completed
                      ? 'border-primary/60 bg-primary/10 text-foreground'
                      : 'border-border bg-background/70 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                    isDisabled && 'cursor-default opacity-70 hover:border-border hover:text-muted-foreground',
                  )}
                >
                  {index + 1}
                </button>
                {index < part.questions.length - 1 ? (
                  <div
                    className={cn(
                      'mx-2 h-px min-w-4 flex-1',
                      completed ? 'bg-primary/40' : 'bg-border',
                    )}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {isReadOnly ? renderReadOnlyQuestions() : <div className="min-h-[18rem]">{renderQuestion()}</div>}

      {error ? <div className="mt-3 text-xs text-destructive">{error}</div> : null}
      {isReadOnly ? null : isAnswered ? (
        <div className="mt-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Check size={13} />
          <span>{submittedResume?.action === 'cancel' ? 'Cancelled' : 'Answered'}</span>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={isDisabled} onClick={cancel}>
            <X size={14} />
            Cancel
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isDisabled || safeQuestionIndex === 0}
              onClick={goToPreviousQuestion}
            >
              Back
            </Button>
            {safeQuestionIndex < part.questions.length - 1 ? (
              <Button type="button" size="sm" disabled={!currentQuestionAnswered || isDisabled} onClick={goToNextQuestion}>
                Next
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={!answers || isDisabled} onClick={submit}>
                {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Submit
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
