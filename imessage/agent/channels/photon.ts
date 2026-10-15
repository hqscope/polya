// Polya's iMessage channel (Photon). Every inbound text goes through onMessage first:
//
// - Group chats, our own echoes, bots and empty events are dropped.
// - An unlinked sender gets a one-time link to connect their Polya account. That reply is posted
//   straight to the thread from here, so no model turn runs for people Polya doesn't know.
// - A linked student's message counts against a per-student daily cap (the shared usage_daily
//   meter), then dispatches with the student's Polya user id on the session auth, where tools
//   read it (lib/student.ts). The model never supplies a user id.
//
// The default export is the channel: schedules/ hands check-ins to it with
// `to(photon, { adapterName: "imessage", threadId })`, using the thread id saved here.
import { defaultPhotonAuth, photonIMessageChannel } from "eve/channels/photon";

import { serviceDb } from "../lib/db.ts";
import { hoursUntilUtcMidnight, localTimeContext, safeTimeZone } from "../lib/dates.ts";
import {
  capDecision,
  capReachedMessage,
  checkSender,
  dailyReplyCap,
  DAILY_REPLY_BUCKET,
  decideLink,
  hostOf,
  isDirectThreadId,
  linkMessage,
  linkPendingMessage,
  shouldIssueCode,
  unavailableMessage,
  type InboundAuthor,
} from "../lib/inbound.ts";
import {
  appUrl,
  countOpenCodes,
  createLinkCode,
  findLinkByHandle,
  linkUrl,
  saveThreadId,
} from "../lib/link.ts";
import { STUDENT_ATTRIBUTE } from "../lib/student.ts";

// The parts of the Chat SDK thread and message this file uses. eve types them with the optional
// `chat` package, which this project doesn't install, so they are spelled out here.
interface ReplyThread {
  readonly id: string;
  readonly isDM?: boolean;
  post(message: string): Promise<unknown>;
}

interface InboundMessage {
  readonly author: InboundAuthor;
  readonly text?: string;
  readonly attachments?: readonly unknown[];
}

const LOG = "[polya-imessage]";

async function reply(thread: ReplyThread, text: string): Promise<void> {
  try {
    await thread.post(text);
  } catch (error) {
    console.error(`${LOG} direct reply failed:`, error instanceof Error ? error.message : error);
  }
}

function hasContent(message: InboundMessage): boolean {
  return (message.text ?? "").trim().length > 0 || (message.attachments?.length ?? 0) > 0;
}

/** Today's count for this student after this message, or null when the meter failed. */
async function countReply(userId: string): Promise<number | null> {
  try {
    const { data, error } = await serviceDb().rpc("increment_usage_daily", {
      p_user_id: userId,
      p_bucket: DAILY_REPLY_BUCKET,
      p_units: 1,
    });
    if (error) {
      console.error(`${LOG} reply meter failed:`, error.message);
      return null;
    }
    const total = Number(data);
    return Number.isFinite(total) ? total : null;
  } catch (error) {
    console.error(`${LOG} reply meter threw:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function sendLink(thread: ReplyThread, handle: string): Promise<void> {
  const db = serviceDb();
  const now = new Date();
  if (!shouldIssueCode(await countOpenCodes(db, handle, now))) {
    await reply(thread, linkPendingMessage());
    return;
  }
  const code = await createLinkCode(db, handle, now);
  await reply(thread, linkMessage(linkUrl(appUrl(), code)));
}

export default photonIMessageChannel({
  // Read at first use, not at import, so builds and tests don't need the secrets.
  credentials() {
    const projectId = process.env.IMESSAGE_PROJECT_ID;
    const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
    if (!projectId || !projectSecret) {
      throw new Error("IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET are required.");
    }
    return { projectId, projectSecret };
  },
  // webhookSecret is left unset on purpose: the channel falls back to IMESSAGE_WEBHOOK_SECRET.
  userName: "Polya",

  async onMessage(ctx, rawMessage) {
    const thread: ReplyThread = ctx.thread;
    const message: InboundMessage = rawMessage;
    if (!hasContent(message)) return null;

    const isDirect = typeof thread.isDM === "boolean" ? thread.isDM : isDirectThreadId(thread.id);
    const sender = checkSender(message.author, isDirect);
    if (sender.kind === "ignore") {
      if (sender.reason === "group-chat" || sender.reason === "unknown-handle") {
        console.info(`${LOG} ignored inbound message: ${sender.reason}`);
      }
      return null;
    }

    try {
      const link = await findLinkByHandle(serviceDb(), sender.handle);
      const decision = decideLink(link, thread.id);

      if (decision.kind === "needs-link") {
        await sendLink(thread, sender.handle);
        return null;
      }

      if (decision.saveThreadId) {
        // Best effort: check-ins need the thread, but the student's message shouldn't wait on it.
        await saveThreadId(serviceDb(), decision.userId, thread.id).catch((error: unknown) => {
          console.error(`${LOG} saving thread failed:`, error instanceof Error ? error.message : error);
        });
      }

      const now = new Date();
      switch (capDecision(await countReply(decision.userId), dailyReplyCap())) {
        case "notify":
          await reply(thread, capReachedMessage(hoursUntilUtcMidnight(now), hostOf(appUrl())));
          return null;
        case "silent":
          return null;
        case "unavailable":
          await reply(thread, unavailableMessage());
          return null;
        case "allow":
          break;
      }

      const auth = defaultPhotonAuth(rawMessage);
      return {
        auth: { ...auth, attributes: { ...auth.attributes, [STUDENT_ATTRIBUTE]: decision.userId } },
        context: [localTimeContext(now, safeTimeZone(decision.timezone))],
      };
    } catch (error) {
      console.error(`${LOG} inbound handling failed:`, error instanceof Error ? error.message : error);
      await reply(thread, unavailableMessage());
      return null;
    }
  },
});
