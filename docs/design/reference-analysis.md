# Grok Bot reference analysis

This note records the product patterns that should inform Cowork. It combines a limited live inspection of the installed desktop app with Grok Bot's public documentation and changelog. The signed-in account contains private conversations; none of their content or screenshots are retained or used here.

## What I inspected

- The installed macOS app opened to its existing signed-in workspace. I did not inspect or use conversation content.
- From the app's non-content controls, I opened the blank **Create New Bot** dialog and inspected its fields, then cancelled it without creating a Bot.
- A live screenshot showed a left Bot list, central conversation/composer, and right details panel. The right panel has **Details**, **Library**, and **Computer** tabs. The new-Bot dialog is centered over the workspace and presents an avatar shape, color choices, a name field, and Cancel/Create actions.
- I did not enter text, submit the dialog, or inspect the post-creation screen. The app's text field could not be safely driven in the background, and bringing it forward would take focus from the user's current app.

## Product patterns to carry forward

### A persistent worker has a clear job

Grok Bot models a Bot as a named role with a separate conversation and working context. Its setup guidance recommends a focused outcome, explicit tools and sources, working style, approval boundary, and schedule. For Cowork, the creation flow should collect a name and purpose first, then make the permission boundary visible before granting access. Keep temporary task prompts separate from durable instructions. [Bot setup](https://docs.x.ai/grok-bot/bots)

### Work stays visible in the conversation

Grok Bot's transcript includes messages alongside tool activity, computer use, files, questions, approval requests, and voice artifacts. It supports follow-up messages while work is underway and direct redirection. Cowork should keep the task transcript as the user's home surface and show activity as readable, ordered events; the computer view and files can live in adjacent inspector tabs. [Messaging and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)

### Handoffs need an owner and a visible result

Grok Bot supports direct asynchronous handoffs and group chats where participating Bots share one outcome. The docs recommend one owner at each stage and warn that excessive fan-out creates duplicate work. Cowork should show each child task, its owner, status, and returned result under the parent task. [Messaging and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)

### Computer activity is inspectable, not decorative

The computer view exposes the active screen and lets a person take over for sensitive steps. Grok Bot explicitly pauses for credentials, MFA, CAPTCHA, payments, and identity checks. Cowork should show the live desktop, action status, and a clear take-over/return-to-agent control. A person must complete blocked identity steps; the agent should not work around them. [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)

### Shared machine access is a real security boundary

Grok Bot shares one account computer among its Bots: browser sessions, files, and command-line credentials are account-wide. Per-Bot screens are not isolation boundaries. Cowork must make its own execution isolation explicit. A shared workspace is convenient for handoffs, but it cannot be described as private per worker unless processes, credentials, and files are actually isolated. [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)

## Create flow and motion

The live dialog is deliberately small: a name, avatar choices, color choices, and an explicit Create action. Public docs say creation then opens the new Bot; profile editing includes its name, label, description, and avatar. This makes the first step quick while leaving the durable job details available on the profile. [Bot setup](https://docs.x.ai/grok-bot/bots)

The changelog records two useful post-create details: a new Bot introduces itself in the configured language, and emoji reactions use a short pop-in animation. The live inspection did not reach the new Bot greeting or capture motion, so it does not establish the timing or visual treatment of a new-Bot animation. Cowork should use a brief, reduced-motion-aware entrance for a newly added worker and then transition directly into a useful first-task prompt; validate that interaction in a fresh test account before treating it as a reference match. [Grok Bot changelog](https://x.ai/changelog/bot)

## Cowork design direction

1. Keep a stable Bot/task list at left, the conversation and live activity in the center, and context tabs at right.
2. Make **New coworker** available from the roster. Ask for a name, a concrete job, and the approval boundary; show optional avatar styling as secondary.
3. After creation, land in the new coworker's conversation with a short identity message and a clear first-task composer.
4. Render tool calls, computer activity, child tasks, questions, and approval requests as distinct transcript events with current status.
5. Keep stop, redirect, approve, and take-over actions near the active work and show which effects have already happened.
6. Label where each worker runs and which files, browser state, and credentials it can access.

## Inspection limits

- No app content from the signed-in workspace is quoted or incorporated. No screenshot was saved as a project artifact.
- The live creation dialog was cancelled without creating a Bot. The post-create greeting, animation timing, and subsequent profile screen were not observed.
- Public documentation describes the product contract; it is not proof that every deployment or account has the same feature rollout.
