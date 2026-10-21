import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconClockPlay,
  IconHelpCircle,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentQueryOptions } from "@/lib/agents/queries";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  type BotActivity,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  routine: "Routine",
  responsibility: "Responsibility",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

/** Where an item opens: its conversation when it has one, otherwise the screen that owns its kind. */
function linkFor(item: ActivityItem, agentId: string) {
  if (item.channelId)
    return (
      <Link to="/channel/$channelId" params={{ channelId: item.channelId }} />
    );
  switch (item.kind) {
    case "approval":
    case "question":
      return <Link params={{ agentId }} to="/bots/$agentId" />;
    case "responsibility":
      return <Link params={{ agentId }} to="/bots/$agentId/responsibilities" />;
    case "routine":
      return <Link params={{ agentId }} to="/bots/$agentId/routines" />;
    default:
      return null;
  }
}

function ActivityRow({
  agentId,
  currentChannelId,
  item,
}: {
  agentId: string;
  currentChannelId?: string;
  item: ActivityItem;
}) {
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  // A row already in the open conversation would link back to it without its panel, closing the panel.
  const link =
    currentChannelId !== undefined && item.channelId === currentChannelId
      ? null
      : linkFor(item, agentId);
  const when = relativeTime(item.at);
  const control = item.stoppable ? (
    <Button
      disabled={stop.isPending}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {stop.isPending ? "Stopping…" : "Stop"}
    </Button>
  ) : item.cancellable ? (
    <Button
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? "Cancelling…" : "Cancel"}
    </Button>
  ) : null;
  const content = (
    <>
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {KIND_LABEL[item.kind]} · {item.needsYou ? "needs you" : item.status}
          {when ? ` · ${when}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  if (control)
    return (
      <Item size="sm">
        {content}
        <ItemActions>
          {link ? (
            <Button render={link} size="sm" variant="ghost">
              Open
            </Button>
          ) : null}
          {control}
        </ItemActions>
      </Item>
    );
  return link ? (
    <Item render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item size="sm">{content}</Item>
  );
}

function ActivitySection({
  agentId,
  currentChannelId,
  empty,
  items,
  title,
}: {
  agentId: string;
  /** The conversation the rows are shown in; its own rows do not link back to it. */
  currentChannelId?: string;
  /** Absent means an empty group is left out entirely, as the conversation panel wants. */
  empty?: string;
  items: ActivityItem[];
  title: string;
}) {
  if (items.length === 0 && empty === undefined) return null;
  return (
    <PageSection title={title}>
      {items.length === 0 ? (
        <PageEmpty>{empty}</PageEmpty>
      ) : (
        <PageRows>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <Separator /> : null}
              <ActivityRow
                agentId={agentId}
                currentChannelId={currentChannelId}
                item={item}
              />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title="Activity">
        <p className="mt-4 text-destructive text-sm" role="alert">
          Could not load this Bot's activity.
        </p>
      </PageSection>
    );
  return (
    <>
      <ActivitySection
        agentId={agentId}
        empty="Nothing is running or waiting on you."
        items={activity.data.inProgress}
        title="In progress"
      />
      <ActivitySection
        agentId={agentId}
        empty="Nothing is scheduled."
        items={activity.data.scheduled}
        title="Scheduled"
      />
      <ActivitySection
        agentId={agentId}
        empty="Nothing has finished yet."
        items={activity.data.completed}
        title="Completed"
      />
    </>
  );
}

export type ChannelWork = Record<
  "needsYou" | "inProgress" | "scheduled" | "completed",
  ActivityItem[]
>;

/**
 * This conversation's work, in the order the person acts on it. Needs-you items lead wherever the
 * server listed them; the rest keep the server's own order, which is the only ordering there is.
 */
export function channelWork(
  activity: BotActivity,
  channelId: string,
): ChannelWork {
  const here = (items: ActivityItem[]) =>
    items.filter((item) => item.channelId === channelId);
  const elsewhere = (items: ActivityItem[]) =>
    here(items).filter((item) => !item.needsYou);
  return {
    needsYou: here([
      ...activity.inProgress,
      ...activity.scheduled,
      ...activity.completed,
    ]).filter((item) => item.needsYou),
    inProgress: elsewhere(activity.inProgress),
    scheduled: elsewhere(activity.scheduled),
    completed: elsewhere(activity.completed),
  };
}

/**
 * The work a conversation holds, beside the chat. Channel-less work such as routines and
 * responsibilities is not here, so the footer opens the Bot's own page, which lists all of it.
 */
export function ChannelWorkPanel({
  agentId,
  channelId,
}: {
  agentId: string;
  channelId: string;
}) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  const agent = useQuery(agentQueryOptions(agentId));
  const name = agent.data?.name ?? "this Bot";

  let body: ReactNode;
  if (activity.isPending) {
    body = (
      <p className="text-muted-foreground text-sm" role="status">
        Loading your work in this conversation…
      </p>
    );
  } else if (!activity.data) {
    body = (
      <p className="text-destructive text-sm" role="alert">
        Could not load your work in this conversation.
      </p>
    );
  } else {
    const work = channelWork(activity.data, channelId);
    const groups = [
      ["Needs you", work.needsYou],
      ["In progress", work.inProgress],
      ["Scheduled", work.scheduled],
      ["Recently completed", work.completed],
    ] as const;
    const hasWork = groups.some(([, items]) => items.length > 0);
    body = (
      <>
        {activity.error ? (
          <p className="text-destructive text-sm" role="alert">
            Could not refresh. Showing the last update.
          </p>
        ) : null}
        {hasWork ? (
          groups.map(([title, items]) => (
            <ActivitySection
              agentId={agentId}
              currentChannelId={channelId}
              items={items}
              key={title}
              title={title}
            />
          ))
        ) : (
          <PageEmpty>
            No work here is waiting on you, running, scheduled, or recent.
          </PageEmpty>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">
        Your own work in this conversation. Completed work shown here is recent
        only.
      </p>
      {body}
      <Link
        className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        params={{ agentId }}
        to="/bots/$agentId"
      >
        All work for {name}
      </Link>
    </div>
  );
}
