import { CardRenderer } from "../feishu/CardRenderer.js";
import { isThreadContextKey } from "../feishu/contextKey.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { TerminalCardView } from "./TerminalServer.js";

export async function sendTerminalAuthorization(
  outbound: Pick<FeishuOutbound, "sendInteractiveCard" | "replyInteractiveCard">,
  view: TerminalCardView,
): Promise<string | undefined> {
  const card = new CardRenderer().renderTerminalAuthorization(view);
  if (isThreadContextKey(view.contextKey)) {
    if (!outbound.replyInteractiveCard || !view.commandCardMessageId) {
      throw new Error("无法向原话题发送终端授权卡，请重新打开命令卡片。");
    }
    return outbound.replyInteractiveCard(view.contextKey, { messageId: view.commandCardMessageId, replyInThread: true }, card);
  }
  return outbound.sendInteractiveCard(view.contextKey, card);
}
