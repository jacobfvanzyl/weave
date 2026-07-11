# ask_user

## Description

Ask the user one to three structured clarification questions and pause until they answer. Use only when missing information materially changes the plan, implementation, or tradeoff. Also use when the user explicitly asks to test, demonstrate, show, or use this tool; in that case ask a harmless sample question. Do not use for secrets, credentials, permission prompts, or routine status updates. Put the recommended option first when there is a clear default; the UI always provides a custom answer path.

## Inputs

### questions

One to three concise structured questions.

### questions[].id

Stable question id used to map the user answer.

### questions[].header

Short section label for this question.

### questions[].question

The question to ask the user.

### questions[].options

Two to four meaningful, mutually exclusive options.

### questions[].options[].id

Stable option id. Use short kebab_case, snake_case, or camelCase.

### questions[].options[].label

Short user-facing option label. Put the recommended option first.

### questions[].options[].description

One concise sentence explaining the tradeoff.
