import { ConversationView } from "@/components/chat/ConversationView";

export default async function ConversationPage(props: PageProps<"/app/c/[channelId]">) {
  const [{ channelId }, searchParams] = await Promise.all([props.params, props.searchParams]);
  // `?message=<id>` opens the chat on that message and highlights it.
  const message = typeof searchParams.message === "string" ? searchParams.message : undefined;
  return <ConversationView channelId={channelId} focusMessageId={message} />;
}
