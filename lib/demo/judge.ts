/**
 * Judge mode (demo only): who the browser is acting as, what every other
 * participant of the outing still has to do, and the single next step.
 *
 * Pure: derived from an OutingView the viewer is already allowed to see, so it
 * can never expose anything the view does not (private vote amounts stay
 * private; only `hasVoted` is used). Safe to import from client components.
 */
import type { OutingView, PersonView } from "../contracts/views";
import { MIN_VOTES_FOR_REVEAL } from "../domain/types";

export type JudgeTodoKind =
  | "INVITE_AND_START_BUDGET"
  | "START_BUDGET"
  | "VOTE"
  | "REVEAL"
  | "INVITE_MORE_VOTERS"
  | "AGREE_BUDGET"
  | "OPEN_COLLECTION"
  | "COMMIT"
  | "ACCEPT";

export interface JudgeTodo {
  kind: JudgeTodoKind;
  /** "needs": blocks the outing; "can": the person may move it forward. */
  urgency: "needs" | "can";
  /** Imperative, lower-case, no trailing punctuation, e.g. "reveal the votes". */
  action: string;
}

export interface JudgePerson {
  participantId: string;
  displayName: string;
  isOrganizer: boolean;
  isViewer: boolean;
  todo: JudgeTodo | null;
  /** Short state shown when there is nothing to do, e.g. "committed". */
  note: string | null;
}

export interface JudgeBoard {
  acting: JudgePerson;
  others: JudgePerson[];
  /** One plain sentence starting with "Next:". */
  nextStep: string;
}

const todo = (kind: JudgeTodoKind, urgency: JudgeTodo["urgency"], action: string): JudgeTodo => ({ kind, urgency, action });

/** "needs to vote" / "can reveal the votes". */
export function describeTodo(t: JudgeTodo): string {
  return t.urgency === "needs" ? `needs to ${t.action}` : `can ${t.action}`;
}

function organizerTodoWhileBudgeting(view: OutingView, person: PersonView): JudgeTodo | null {
  const { budget, roster } = view;
  if (budget.revealed) return todo("AGREE_BUDGET", "can", "agree a budget");
  if (!person.hasVoted) return todo("VOTE", "needs", "vote");
  if (budget.votedCount >= MIN_VOTES_FOR_REVEAL) return todo("REVEAL", "can", "reveal the votes");
  // Everyone invited has voted but the reveal minimum protects individual votes: more people are needed.
  const everyoneVoted = roster.people.every((p) => p.hasVoted);
  if (everyoneVoted) return todo("INVITE_MORE_VOTERS", "needs", `invite more people, ${MIN_VOTES_FOR_REVEAL} votes are needed to reveal`);
  return null;
}

function organizerTodo(view: OutingView, person: PersonView): JudgeTodo | null {
  switch (view.outing.status) {
    case "DRAFT":
      return view.roster.people.length < 2
        ? todo("INVITE_AND_START_BUDGET", "can", "invite people and start the budget vote")
        : todo("START_BUDGET", "can", "start the budget vote");
    case "BUDGETING":
      return organizerTodoWhileBudgeting(view, person);
    case "PROPOSED":
      return todo("OPEN_COLLECTION", "can", "pick an option and open commitments");
    default:
      return null;
  }
}

const isOut = (person: PersonView): boolean => person.attendance === "DECLINED" || person.attendance === "WITHDRAWN";

function collectingTodo(person: PersonView): JudgeTodo | null {
  if (isOut(person) || person.committed) return null;
  if (person.payerType === "SPONSORED") return person.attendance === "PENDING" ? todo("ACCEPT", "needs", "accept the invitation") : null;
  return todo("COMMIT", "needs", "commit");
}

/** What one participant still has to do, derived only from data everyone in the outing can see. */
export function todoFor(view: OutingView, person: PersonView): JudgeTodo | null {
  const status = view.outing.status;
  if (status === "COLLECTING") return collectingTodo(person);
  if (status === "BUDGETING" && !view.budget.revealed && !person.hasVoted && !isOut(person)) return todo("VOTE", "needs", "vote");
  if (person.role === "ORGANIZER") return organizerTodo(view, person);
  return null;
}

function noteFor(view: OutingView, person: PersonView): string | null {
  if (person.attendance === "DECLINED") return "declined";
  if (person.attendance === "WITHDRAWN") return "withdrew";
  const status = view.outing.status;
  if (status === "COLLECTING" && person.committed) return person.payerType === "SPONSORED" ? "accepted" : "committed";
  if (status === "BUDGETING" && !view.budget.revealed && person.hasVoted) return "voted";
  return null;
}

function personFor(view: OutingView, person: PersonView): JudgePerson {
  const t = todoFor(view, person);
  return {
    participantId: person.participantId,
    displayName: person.displayName,
    isOrganizer: person.role === "ORGANIZER",
    isViewer: person.participantId === view.viewer.participantId,
    todo: t,
    note: t ? null : noteFor(view, person),
  };
}

const PROCESS_DUE_WORK = "use Process due work on /demo";

function idleNextStep(view: OutingView): string {
  switch (view.outing.status) {
    case "COLLECTING":
      return `Next: wait for the deadline, or ${PROCESS_DUE_WORK}`;
    case "SETTLING":
    case "CANCELLING":
    case "COMPENSATING":
      return `Next: ${PROCESS_DUE_WORK} to run the pending payment operations`;
    default:
      return "Next: nothing left to do here";
  }
}

function nextStepFor(acting: JudgePerson, others: JudgePerson[], view: OutingView): string {
  if (acting.todo) return `Next: you (${acting.displayName}) can ${acting.todo.action}`;
  const next = others.find((p) => p.todo?.urgency === "needs") ?? others.find((p) => p.todo);
  if (next?.todo) return `Next: switch to ${next.displayName} and ${next.todo.action}`;
  return idleNextStep(view);
}

/** The viewer's person entry comes from the roster when present; otherwise it is built from `view.viewer`. */
function actingPerson(view: OutingView, people: JudgePerson[]): JudgePerson {
  const fromRoster = people.find((p) => p.isViewer);
  if (fromRoster) return fromRoster;
  const { viewer } = view;
  return { participantId: viewer.participantId, displayName: viewer.displayName, isOrganizer: viewer.isOrganizer, isViewer: true, todo: null, note: null };
}

export function judgeBoard(view: OutingView): JudgeBoard {
  const people = view.roster.people.map((p) => personFor(view, p));
  const acting = actingPerson(view, people);
  const others = people.filter((p) => !p.isViewer);
  return { acting, others, nextStep: nextStepFor(acting, others, view) };
}
