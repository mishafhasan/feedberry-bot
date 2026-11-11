import type { MessagePlan } from '../render/message-plan.ts';
import type { TelegramSender } from '../telegram/api.ts';
import type { Target } from '../telegram/target.ts';

/** Stage 7: the only stage that sends. Rate limiting lives in the sender, so nothing can bypass it. */
export function deliver(sender: TelegramSender, plan: MessagePlan, target: Target): Promise<number[]> {
  return sender.send(plan, target);
}
